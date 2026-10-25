// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The public app's request body limit over a real socket (inner#1006 §3):
 * T01–T06, T08–T10, T12(c), T17, the raw-body regressions X01–X03, and a
 * keep-alive regression: a body within the limit that a route refuses unread
 * must not break the next request on the same connection.
 *
 * `createApp()` is served by `@hono/node-server` on a loopback port
 * (`serveOnLoopback`, as `internal-api-harness.ts` does), and requests are
 * sent with `node:http`, so `Content-Length` and chunked transfer are exactly
 * what the case says. Logs are captured by replacing core's logger.
 *
 * Every size below is stated relative to the 1 MiB default, which the first
 * case pins to `getRequestBodyMaxBytes()`.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
    totalUsage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

/** The webhook verifies with stripe-node's own check under this suite's secret. */
const WEBHOOK_SECRET = "whsec_request_body_limit_suite";

vi.mock("@server/infra/stripe.js", async () => {
  const { default: StripeSdk } = await import("stripe");
  const verifier = new StripeSdk("sk_test_unused_by_this_suite");
  return {
    getStripeClient: () => verifier,
    verifyWebhookSignature: (payload: string | Buffer, signature: string) =>
      verifier.webhooks.constructEvent(payload, signature, "whsec_request_body_limit_suite"),
  };
});

/** Every log line, by level; core's logger is a proxy a spy cannot see into. */
const logged = vi.hoisted(() => {
  const record = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
  return { ...record, child: () => record };
});
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

import postgres from "postgres";
import Stripe from "stripe";
import type { Hono } from "hono";
import {
  env,
  getRedis,
  initCore,
  loadLocales,
  revokeSession,
  runWithLocale,
  sessionCookieName,
  setSession,
  getStorageConfig,
  getStorageAdapter,
} from "@breatic/core";
import { formatBytes, t } from "@breatic/shared";
import { getRequestBodyMaxBytes } from "@server/config/limits.js";
import { PROXY_PEER, withPeer } from "../helpers/peer.js";
import { serveOnLoopback, type RunningApp } from "./internal-api-harness.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let running: RunningApp;
let seq = 0;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "request-body-limit-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
  running = await serveOnLoopback(app);
});

afterAll(async () => {
  await running?.close();
  await sql?.end({ timeout: 1 });
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** 64 KiB, the chunk size every chunked case sends. */
const CHUNK = 65_536;

/**
 * The limit the sizes below are computed for: the 1 MiB default of
 * `request_body_max_bytes`. Written out so the cases that pass on main today
 * (T01, T03, T05, X01–X03) do not depend on the getter that does not exist
 * yet; the first case pins it to `getRequestBodyMaxBytes()`.
 * @returns 1048576.
 */
function limit(): number {
  return 1_048_576;
}

/**
 * The 413 answer the server must give, in English.
 * @returns The response body.
 */
function tooLarge(): { error: { code: number; message: string } } {
  return {
    error: {
      code: 413,
      message: runWithLocale("en", () => t("server.error.payload_too_large", { limit: formatBytes(limit()) })),
    },
  };
}

/** What a request sent over the socket got back. */
interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  /** Bytes of the body the client had handed to the socket when the answer arrived. */
  writtenAtAnswer: number;
  /** Whether the request went out on a socket an earlier request had used. */
  reusedSocket: boolean;
}

/** How one request is sent. */
interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Sent with a matching `Content-Length` unless `chunkSize` is given. */
  body?: Buffer;
  /** Send `body` chunked, in pieces of this size, without `Content-Length`. */
  chunkSize?: number;
  /** Send this many bytes chunked, produced by `bodyAt`, stopping once answered. */
  stream?: { total: number; bodyAt: (offset: number, length: number) => Buffer };
  /** The connection pool to send through; the default global agent otherwise. */
  agent?: http.Agent;
}

/**
 * Send one request to the served app over a real socket.
 * @param path - Path with query.
 * @param opts - What to send.
 * @returns The answer.
 */
function send(path: string, opts: SendOptions = {}): Promise<Answer> {
  const url = new URL(path, running.baseUrl);
  const chunked = opts.chunkSize !== undefined || opts.stream !== undefined;
  const headers: Record<string, string> = { ...opts.headers };
  if (chunked) headers["Transfer-Encoding"] = "chunked";
  else if (opts.body !== undefined) headers["Content-Length"] = String(opts.body.length);
  return new Promise<Answer>((resolve, reject) => {
    let written = 0;
    let answered = false;
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: opts.method ?? "POST", headers, agent: opts.agent },
      (res) => {
        answered = true;
        const at = written;
        const parts: Buffer[] = [];
        res.on("data", (d: Buffer) => parts.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(parts).toString("utf-8"),
            writtenAtAnswer: at,
            reusedSocket: req.reusedSocket,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", (err) => {
      // A refusal may close the socket while the client is still writing;
      // the case passes on the answer, which has already arrived.
      if (!answered) reject(err);
    });
    /**
     * Write one piece, waiting for the socket to drain when it asks.
     * @param piece - The bytes.
     * @returns Once the socket can take more.
     */
    const write = async (piece: Buffer): Promise<void> => {
      const ok = req.write(piece);
      written += piece.length;
      if (!ok) {
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 200);
          req.once("drain", () => {
            clearTimeout(timer);
            done();
          });
        });
      }
    };
    void (async () => {
      if (opts.stream) {
        const { total, bodyAt } = opts.stream;
        for (let offset = 0; offset < total && !answered; offset += CHUNK) {
          await write(bodyAt(offset, Math.min(CHUNK, total - offset)));
        }
      } else if (opts.body !== undefined && opts.chunkSize !== undefined) {
        for (let offset = 0; offset < opts.body.length && !answered; offset += opts.chunkSize) {
          await write(opts.body.subarray(offset, offset + opts.chunkSize));
        }
      } else if (opts.body !== undefined) {
        await write(opts.body);
      }
      if (!req.destroyed) req.end();
    })().catch((err: unknown) => {
      if (!answered) reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * A JSON object serialized and padded with spaces before its closing brace
 * to exactly `size` bytes.
 * @param value - The object.
 * @param size - The byte length wanted.
 * @returns The padded JSON.
 */
function padded(value: Record<string, unknown>, size: number): Buffer {
  const json = JSON.stringify(value);
  const pad = size - Buffer.byteLength(json);
  expect(pad).toBeGreaterThanOrEqual(0);
  return Buffer.from(`${json.slice(0, -1)}${" ".repeat(pad)}}`, "utf-8");
}

/**
 * The first argument of every log call with this message, at any level.
 * @param message - The pino message.
 * @returns The fields of each call.
 */
function logsNamed(message: string): unknown[] {
  return [logged.error, logged.warn, logged.info, logged.debug].flatMap((fn) =>
    fn.mock.calls.filter((call) => call[1] === message).map((call) => call[0] as unknown),
  );
}

/** A signed-in editor with a studio, a project and a conversation. */
interface Seeded {
  userId: string;
  studioId: string;
  projectId: string;
  conversationId: string;
  token: string;
  cookie: string;
}

/**
 * An owner of a project in their personal studio, signed in.
 * @returns The ids and the session cookie.
 */
async function seedOwner(): Promise<Seeded> {
  seq += 1;
  const tag = `rbl-${Date.now().toString(36)}-${seq}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`${tag}-s`}, 'personal', 'Personal') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${userId}, ${`P ${tag}`}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${userId}, 'owner', null)
  `;
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, title, project_id) VALUES (${userId}, 'seeded', ${project!.id}) RETURNING id
  `;
  const token = randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId: studio!.id,
    projectId: project!.id,
    conversationId: conversation!.id,
    token,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * `SNAP(t)`: a snapshot body with `text` of `n` copies of "a".
 * @param projectId - P.
 * @param nodeId - N.
 * @param n - How many characters of text.
 * @returns The JSON bytes.
 */
function snap(projectId: string, nodeId: string, n: number): Buffer {
  return Buffer.from(JSON.stringify({ project_id: projectId, node_id: nodeId, text: "a".repeat(n) }), "utf-8");
}

/**
 * How many history rows a node has.
 * @param nodeId - The node.
 * @returns The count.
 */
async function historyRows(nodeId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM node_history WHERE node_id = ${nodeId}`;
  return row!.n;
}

/**
 * The request count in one user-keyed rate-limit window.
 * @param action - The limited action.
 * @param userId - The user.
 * @returns The bucket's size (0 when absent).
 */
async function userBucket(action: string, userId: string): Promise<number> {
  return getRedis().zcard(`${env.ENV}:ratelimit:${action}:${userId}`);
}

/** The login body T01 and T02 pad. */
const LOGIN = { email: "nobody@example.com", password: "x" };

describe("§2 the limit itself (T01–T06)", () => {
  it("the sizes here are measured against getRequestBodyMaxBytes()", () => {
    expect(getRequestBodyMaxBytes()).toBe(limit());
  });

  it("T01: a login body of exactly the limit reaches the route", async () => {
    const res = await send("/api/v1/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: padded(LOGIN, limit()),
    });

    expect(res.status).toBe(401);
    expect(logsNamed("request_body_too_large")).toEqual([]);
  });

  it("T02: a login body one byte over is 413 with the limit named, before validate or the rate limit", async () => {
    const res = await send("/api/v1/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: padded(LOGIN, limit() + 1),
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual(tooLarge());
    expect(tooLarge().error.message).toBe("This request is larger than 1 MiB. Shorten the prompt or the text it refers to.");

    // A loopback client is never counted, so the rate-limit half is asked of
    // a request that came through the proxy, which would be counted.
    const viaProxy = await withPeer(app, PROXY_PEER).request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(limit() + 1), "X-Real-IP": "203.0.113.50" },
      body: padded(LOGIN, limit() + 1),
    });
    expect(viaProxy.status).toBe(413);
    const emailHash = createHash("sha256").update(LOGIN.email).digest("hex");
    expect(await getRedis().exists(`${env.ENV}:ratelimit:login-ip:203.0.113.50`)).toBe(0);
    expect(await getRedis().exists(`${env.ENV}:ratelimit:login:203.0.113.50:${emailHash}`)).toBe(0);
  });

  it("T03: a snapshot of exactly the limit is written", async () => {
    const a = await seedOwner();
    const nodeId = randomUUID();
    const body = snap(a.projectId, nodeId, 1_048_464);
    expect(body.length).toBe(limit());

    const res = await send("/api/v1/canvas/node-history/snapshot", {
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body,
    });

    expect(res.status).toBe(201);
    const rows = await sql<{ n: number }[]>`SELECT length(content)::int AS n FROM node_history WHERE node_id = ${nodeId}`;
    expect(rows).toEqual([{ n: 1_048_464 }]);
  });

  it("T04: a snapshot one byte over is 413 and writes nothing, not even a rate-limit hit", async () => {
    const a = await seedOwner();
    const nodeId = randomUUID();
    const body = snap(a.projectId, nodeId, 1_048_465);
    expect(body.length).toBe(limit() + 1);
    const bucketBefore = await userBucket("node-history-snapshot", a.userId);

    const res = await send("/api/v1/canvas/node-history/snapshot", {
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body,
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual(tooLarge());
    expect(await historyRows(nodeId)).toBe(0);
    expect(await userBucket("node-history-snapshot", a.userId)).toBe(bucketBefore);
  });

  it("T05: the same snapshot sent chunked arrives byte for byte", async () => {
    const a = await seedOwner();
    const nodeId = randomUUID();
    const body = snap(a.projectId, nodeId, 1_048_464);

    const res = await send("/api/v1/canvas/node-history/snapshot", {
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body,
      chunkSize: CHUNK,
    });

    expect(res.status).toBe(201);
    const rows = await sql<{ content: string }[]>`SELECT content FROM node_history WHERE node_id = ${nodeId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content === "a".repeat(1_048_464)).toBe(true);
  });

  it("T06: an endless chunked login is refused long before the client stops writing", async () => {
    const prefix = Buffer.from('{"email":"nobody@example.com","password":"x"', "utf-8");
    const total = 64 * 1024 * 1024;

    const res = await send("/api/v1/auth/login", {
      headers: { "Content-Type": "application/json" },
      stream: {
        total,
        bodyAt: (offset, length) => {
          const piece = Buffer.alloc(length, 0x20);
          if (offset === 0) prefix.copy(piece);
          if (offset + length === total) piece[length - 1] = 0x7d;
          return piece;
        },
      },
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual(tooLarge());
    expect(res.writtenAtAnswer).toBeLessThan(8 * 1024 * 1024);
    expect(logsNamed("user_logged_in")).toEqual([]);
  });
});

describe("§2 a body within the limit that a route refuses unread", () => {
  it("leaves the keep-alive connection usable for the next request", async () => {
    // One socket only, so the second request has to go out on the connection
    // the first one used. A signed-out snapshot is refused by requireAuth
    // before anything reads the body, so the 300 KB stay unread on the socket.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const refused = await send("/api/v1/canvas/node-history/snapshot", {
        agent,
        headers: { "Content-Type": "application/json" },
        body: padded({ project_id: randomUUID(), node_id: randomUUID(), text: "a" }, 300_000),
      });
      expect(refused.status).toBe(401);
      expect(refused.reusedSocket).toBe(false);

      const next = await send("/api/v1/assets/upload-config", { method: "GET", agent });

      expect(next.reusedSocket).toBe(true);
      expect(next.status).toBe(401);
    } finally {
      agent.destroy();
    }
  });
});

describe("§2 every entrance is behind the limit (T08)", () => {
  it("register, the Stripe webhook, project create, upload ticket and chat all answer 413 and run nothing", async () => {
    const a = await seedOwner();
    const over = limit() + 1;
    const idempotencyKey = randomUUID();
    const cases: Array<{ path: string; headers: Record<string, string>; body: Buffer }> = [
      {
        path: "/api/v1/auth/register",
        headers: { "Content-Type": "application/json" },
        body: padded({ email: `rbl-register-${Date.now()}@example.com`, password: "password-123" }, over),
      },
      {
        path: "/api/v1/payment/webhook",
        headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
        body: padded({ id: "evt_rbl", type: "customer.created" }, over),
      },
      {
        path: "/api/v1/projects",
        headers: { "Content-Type": "application/json", Cookie: a.cookie, "Idempotency-Key": idempotencyKey },
        body: padded({ studioId: a.studioId, name: "Over the limit", slug: `rbl-over-${Date.now()}` }, over),
      },
      {
        path: "/api/v1/assets/upload-ticket",
        headers: { "Content-Type": "application/json", Cookie: a.cookie },
        body: padded({ project_id: a.projectId, filename: "a.png", content_type: "image/png", size: 10, client_hash: "0".repeat(64) }, over),
      },
      {
        path: "/api/v1/chat/message",
        headers: { "Content-Type": "application/json", Cookie: a.cookie },
        body: padded({ message: "hi", project_id: a.projectId, conversation_id: a.conversationId, attached_chips: [] }, over),
      },
    ];

    const answers: Array<{ path: string; status: number; body: unknown }> = [];
    for (const c of cases) {
      const res = await send(c.path, { headers: c.headers, body: c.body });
      answers.push({ path: c.path, status: res.status, body: res.status === 413 ? (JSON.parse(res.text) as unknown) : res.text.slice(0, 200) });
    }

    expect(answers).toEqual(cases.map((c) => ({ path: c.path, status: 413, body: tooLarge() })));

    expect(logsNamed("Stripe webhook signature verification failed")).toEqual([]);
    expect(await getRedis().keys(`${env.REDIS_KEY_PREFIX}:server:idempotency:${a.userId}:*`)).toEqual([]);
  });
});

describe("§2.1 what a refusal logs (T09, T10, T12c)", () => {
  it("T09: a signed-in refusal logs the path, method, declared size, client and user", async () => {
    const a = await seedOwner();
    const path = "/api/v1/canvas/node-history/snapshot";

    const res = await send(path, {
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: snap(a.projectId, randomUUID(), 1_048_465),
    });

    expect(res.status).toBe(413);
    const declared = limit() + 1;
    expect(declared).toBe(1_048_577);
    expect(logsNamed("request_body_too_large")).toEqual([
      { path, method: "POST", declaredBytes: 1_048_577, client: { kind: "exempt", identity: "127.0.0.1" }, userId: a.userId },
    ]);
    expect(logged.warn).toHaveBeenCalledWith(
      { path, method: "POST", declaredBytes: 1_048_577, client: { kind: "exempt", identity: "127.0.0.1" }, userId: a.userId },
      "request_body_too_large",
    );
    const requestLines = logged.info.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((fields) => fields.path === path);
    expect(requestLines).toEqual([{ method: "POST", path, status: 413, duration: expect.any(Number) }]);
  });

  it("T10: an anonymous chunked refusal logs no declared size and no user", async () => {
    const res = await send("/api/v1/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: padded(LOGIN, limit() + 1),
      chunkSize: CHUNK,
    });

    expect(res.status).toBe(413);
    expect(logsNamed("request_body_too_large")).toEqual([
      { path: "/api/v1/auth/login", method: "POST", declaredBytes: null, client: { kind: "exempt", identity: "127.0.0.1" }, userId: null },
    ]);
    expect(logsNamed("request_body_session_lookup_failed")).toEqual([]);
  });

  it("T12(c): a revoked session's cookie logs userId null and no lookup failure", async () => {
    const a = await seedOwner();
    await revokeSession(getRedis(), a.token);

    const res = await send("/api/v1/canvas/node-history/snapshot", {
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: snap(a.projectId, randomUUID(), 1_048_465),
    });

    expect(res.status).toBe(413);
    expect(logsNamed("request_body_too_large")).toEqual([expect.objectContaining({ userId: null })]);
    expect(logsNamed("request_body_session_lookup_failed")).toEqual([]);
  });
});

describe("§2.2 the browser learns the limit (T17)", () => {
  it("GET /assets/upload-config adds maxRequestBodyBytes and keeps every other field", async () => {
    const a = await seedOwner();
    const { upload } = getStorageConfig();
    const store = await getStorageAdapter();

    const res = await send("/api/v1/assets/upload-config", { method: "GET", headers: { Cookie: a.cookie } });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      data: {
        maxUploadBytes: upload.max_upload_bytes,
        clientMaxAttempts: upload.client_max_attempts,
        clientRetryBaseDelayMs: upload.client_retry_base_delay_ms,
        uploadIdleTimeoutMs: upload.upload_idle_timeout_seconds * 1000,
        uploadStatusPollSeconds: upload.upload_status_poll_seconds,
        assetUrlPrefix: store.publicUrl(""),
        maxRequestBodyBytes: 1_048_576,
      },
    });
    expect(getRequestBodyMaxBytes()).toBe(1_048_576);
  });
});

describe("§9 routes that read the raw body still read the same bytes (X01–X03)", () => {
  const signer = new Stripe("sk_test_unused_by_this_suite");

  /**
   * A signed event Stripe could send and nothing here handles.
   * @returns The payload and its signature header.
   */
  function signedEvent(): { payload: Buffer; signature: string } {
    const payload = JSON.stringify({
      id: `evt_rbl_${randomUUID()}`,
      object: "event",
      api_version: "2025-01-27.acacia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "customer.created",
      data: { object: { id: `cus_rbl_${seq}`, object: "customer" } },
    });
    return { payload: Buffer.from(payload, "utf-8"), signature: signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) };
  }

  it("X01: a signed webhook with Content-Length verifies and is acknowledged", async () => {
    const { payload, signature } = signedEvent();

    const res = await send("/api/v1/payment/webhook", {
      headers: { "Content-Type": "application/json", "stripe-signature": signature },
      body: payload,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ received: true });
    expect(logsNamed("Stripe webhook signature verification failed")).toEqual([]);
  });

  it("X02: the same signed webhook sent chunked verifies too", async () => {
    const { payload, signature } = signedEvent();

    const res = await send("/api/v1/payment/webhook", {
      headers: { "Content-Type": "application/json", "stripe-signature": signature },
      body: payload,
      chunkSize: 64,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ received: true });
    expect(logsNamed("Stripe webhook signature verification failed")).toEqual([]);
  });

  it("X03: a project press resent chunked hashes the same and is replayed", async () => {
    const a = await seedOwner();
    const body = Buffer.from(
      JSON.stringify({ studioId: a.studioId, name: "Pressed twice", slug: `rbl-twice-${Date.now()}` }),
      "utf-8",
    );
    const headers = { "Content-Type": "application/json", Cookie: a.cookie, "Idempotency-Key": randomUUID() };

    const first = await send("/api/v1/projects", { headers, body });
    const again = await send("/api/v1/projects", { headers, body, chunkSize: 16 });

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(JSON.parse(again.text)).toEqual(JSON.parse(first.text));
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM projects WHERE studio_id = ${a.studioId}`;
    // The seeded project plus the one the press made.
    expect(row!.n).toBe(2);
  });
});
