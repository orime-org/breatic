// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `POST /api/v1/ingest/model-keys` (inner#1953): the one endpoint the ingest Worker calls, before each model call of a
 * web-animation execution. The Worker signs the body and a timestamp with the shared secret; the server answers only
 * while the execution runs and only for upstreams in the plan the execution's job was fixed with, from the account key
 * row the execution recorded or, without one, from the deployment's keys, sealed as a JWE to the Worker's public key.
 * A key row replaced or deleted since is a definite `account_key_missing` naming its upstream; our key is never sent
 * instead.
 *
 * Through the real app, database and Redis; the Worker's key pair is made here and the answer opened with the shared
 * code the Worker runs.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** The limit this file lowers to see the 429. */
const LOWERED = vi.hoisted(() => new Set(["ingest-model-keys"]));

vi.mock("@server/config/rate-limits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimitsModule>();
  return {
    ...actual,
    getRateLimit: (action: string) => (LOWERED.has(action) ? { max: 3, windowSeconds: 60 } : actual.getRateLimit(action)),
  };
});

import type * as RateLimitsModule from "@server/config/rate-limits.js";
import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { createProvider } from "@breatic/provider";
import { accountProviderKeysRepo, initCore, loadLocales, sealProviderKey } from "@breatic/core";
import { initProvider, readProviderConfig } from "@breatic/domain";
import {
  MODEL_KEYS_PATH,
  MODEL_KEYS_SIGNATURE_HEADER,
  MODEL_KEYS_TIMESTAMP_HEADER,
  openModelKeys,
  signModelKeysRequest,
} from "@breatic/shared/space-content";
import { mirrorInDirectory } from "./directory-fixtures.js";
import { peer } from "@server/__tests__/helpers/peer.js";

const INGEST_SECRET = "model-keys-suite-secret";
const MASTER = crypto.randomBytes(32);
const RING = { current: "t1", keys: { t1: MASTER } };
const PAIR = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const DEPLOYMENT_OPENROUTER = "sk-or-deployment-suite-key";
const ACCOUNT_OPENROUTER = "sk-or-v1-account-suite-key";
const MODEL = "deepseek/deepseek-v4.1-flash-1017";

/** The bindings and the real address of a request through our nginx, so the limit counts it. */
const VIA_PROXY = peer("10.0.0.7");

let sql: ReturnType<typeof postgres>;
let app: Hono;

/**
 * Configure this process: the shared secret, the seal key and the master keys, with the deployment's keys narrowed.
 * @param overrides - Environment to change.
 * @param deploymentKeys - The deployment's keys by variable.
 */
function configure(overrides: Record<string, string> = {}, deploymentKeys: Record<string, string> = { OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER }): void {
  initCore({
    ...process.env,
    INGEST_SHARED_SECRET: INGEST_SECRET,
    INGEST_KEY_SEAL_PUBLIC_KEY: PAIR.publicKey.replace(/\n/g, "\\n"),
    PROVIDER_KEY_SECRET_ID: "t1",
    PROVIDER_KEY_SECRETS: JSON.stringify({ t1: MASTER.toString("hex") }),
    ...overrides,
  });
  initProvider(createProvider({
    config: readProviderConfig(),
    keyOf: (name: string) => deploymentKeys[name],
    llmMaxRetries: 0,
    cleanText: (text: string) => text,
  }));
}

beforeAll(async () => {
  configure();
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "ingest-model-keys-driver" } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/** The plan a job is fixed with: OpenRouter, then DeepSeek directly. */
const PLAN = {
  model: MODEL,
  candidates: [
    { upstream: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", vendorModel: MODEL, keyEnv: "OPENROUTER_API_KEY" },
    { upstream: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", vendorModel: "deepseek-v4.1-flash", keyEnv: "DEEPSEEK_API_KEY" },
  ],
};

/**
 * A running execution whose job is fixed with {@link PLAN}, in a Studio its creator administers.
 * @param options - Its status, its account key row, or its plan.
 * @param options.status - Its status; `running` by default.
 * @param options.llmKeyId - The account key row it records.
 * @param options.withStep - Whether its job is fixed yet.
 * @returns Its id and its creator.
 */
async function execution(options: { status?: string; llmKeyId?: string | null; withStep?: boolean } = {}): Promise<{ id: string; userId: string }> {
  const tag = crypto.randomBytes(8).toString("hex");
  const [user] = await sql<{ id: string }[]>`INSERT INTO users (email, email_verified) VALUES (${`model-keys-${tag}@example.test`}, true) RETURNING id`;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${userId}, ${`mk-s-${tag}`}, 'team', 'MK') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  await mirrorInDirectory(sql, studio!.id);
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, initial_space_type)
    VALUES (${studio!.id}, ${userId}, ${`mk-p-${tag}`}, ${`mk-p-${tag}`}, 'timeline') RETURNING id
  `;
  const id = crypto.randomUUID();
  const steps = options.withStep === false ? [] : [{ kind: "container_job", request: { containerClass: "WebAnimationContainer", jobId: `timeline:${id}`, messagesPlan: PLAN } }];
  await sql`
    INSERT INTO timeline_executions (id, project_id, space_id, actor_user_id, kind, action_id, input, input_hash, engine, status, steps, deadline_at, llm_key_id)
    VALUES (${id}, ${project!.id}, ${crypto.randomUUID()}, ${userId}, 'web_animation_create', ${tag}, ${sql.json({ prompt: "x" })}, ${`sha256:${tag}`},
            'deepseek', ${options.status ?? "running"}, ${sql.json(steps)}, now() + interval '2 hours', ${options.llmKeyId ?? null})
  `;
  return { id, userId };
}

/**
 * An address no other request of this run used.
 * @returns The address.
 */
function freshIp(): string {
  return `10.${String(crypto.randomInt(256))}.${String(crypto.randomInt(256))}.${String(crypto.randomInt(1, 255))}`;
}

/**
 * Ask for keys the way the Worker does.
 * @param body - The body.
 * @param sign - The secret and timestamp to sign with, or headers to send instead.
 * @param sign.secret - The secret.
 * @param sign.timestamp - Unix seconds.
 * @param sign.headers - Headers sent as they are, unsigned.
 * @param sign.realIp - The address our proxy wrote; a fresh one per request unless given, so only the limit's own case is counted.
 * @returns The response.
 */
async function ask(body: unknown, sign: { secret?: string; timestamp?: number; headers?: Record<string, string>; realIp?: string } = {}): Promise<Response> {
  const text = JSON.stringify(body);
  const timestamp = sign.timestamp ?? Math.floor(Date.now() / 1000);
  const headers = sign.headers ?? {
    [MODEL_KEYS_TIMESTAMP_HEADER]: String(timestamp),
    [MODEL_KEYS_SIGNATURE_HEADER]: await signModelKeysRequest(sign.secret ?? INGEST_SECRET, timestamp, text),
  };
  return app.request(MODEL_KEYS_PATH, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": sign.realIp ?? freshIp(), ...headers }, body: text }, VIA_PROXY);
}

/**
 * The keys an answer sealed, opened with the Worker's private key.
 * @param res - A 200 answer.
 * @returns The keys.
 */
async function opened(res: Response): Promise<Record<string, string>> {
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/jose");
  return openModelKeys(await res.text(), PAIR.privateKey);
}

describe("POST /api/v1/ingest/model-keys", () => {
  it("answers the deployment's key for an execution with no account key row, sealed so the body never shows it", async () => {
    configure();
    const { id } = await execution();
    const res = await ask({ executionId: id, upstreams: ["openrouter"] });

    expect(await res.clone().text()).not.toContain(DEPLOYMENT_OPENROUTER);
    expect(await opened(res)).toEqual({ openrouter: DEPLOYMENT_OPENROUTER });
  });

  it("answers only the asked upstreams the deployment holds a key for", async () => {
    configure();
    const { id } = await execution();

    expect(await opened(await ask({ executionId: id, upstreams: ["openrouter", "deepseek"] }))).toEqual({ openrouter: DEPLOYMENT_OPENROUTER });
  });

  it("answers the account's key, never ours, for an execution that recorded its key row", async () => {
    configure();
    const owner = await execution({ withStep: false });
    const saved = await accountProviderKeysRepo.saveKey({ userId: owner.userId, upstream: "openrouter", ciphertext: sealProviderKey(ACCOUNT_OPENROUTER, RING), displayHint: "h" });
    const { id } = await execution({ llmKeyId: saved.id });

    expect(await opened(await ask({ executionId: id, upstreams: ["openrouter"] }))).toEqual({ openrouter: ACCOUNT_OPENROUTER });
  });

  it("refuses with account_key_missing naming the upstream once the key row was deleted, and sends none of ours", async () => {
    configure();
    const owner = await execution({ withStep: false });
    const saved = await accountProviderKeysRepo.saveKey({ userId: owner.userId, upstream: "openrouter", ciphertext: sealProviderKey(ACCOUNT_OPENROUTER, RING), displayHint: "h" });
    await accountProviderKeysRepo.deleteKey(owner.userId, "openrouter");
    const { id } = await execution({ llmKeyId: saved.id });
    const res = await ask({ executionId: id, upstreams: ["openrouter"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "account_key_missing", upstream: "openrouter" });
  });

  it("refuses with not_configured when the deployment holds a key for none of the asked upstreams", async () => {
    configure({}, {});
    const { id } = await execution();
    const res = await ask({ executionId: id, upstreams: ["openrouter", "deepseek"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "not_configured" });
  });

  it.each(["queued", "cancelling", "succeeded", "failed"])("answers 404 for an execution that is %s, not running", async (status) => {
    configure();
    const { id } = await execution({ status });

    expect((await ask({ executionId: id, upstreams: ["openrouter"] })).status).toBe(404);
  });

  it("answers 404 for an execution that does not exist or has no job fixed yet", async () => {
    configure();
    const { id } = await execution({ withStep: false });

    expect((await ask({ executionId: crypto.randomUUID(), upstreams: ["openrouter"] })).status).toBe(404);
    expect((await ask({ executionId: id, upstreams: ["openrouter"] })).status).toBe(404);
  });

  it("answers 403 for an upstream outside the execution's plan, and seals nothing", async () => {
    configure({}, { OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER, FAL_KEY: "fal-deployment-key" });
    const { id } = await execution();
    const res = await ask({ executionId: id, upstreams: ["openrouter", "fal"] });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("fal-deployment-key");
  });

  it("answers 401 for a wrong secret, a stale timestamp or missing headers, and 422 for a body that is not a request", async () => {
    configure();
    const { id } = await execution();
    const body = { executionId: id, upstreams: ["openrouter"] };

    expect((await ask(body, { secret: "another-secret" })).status).toBe(401);
    expect((await ask(body, { timestamp: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await ask(body, { headers: {} })).status).toBe(401);
    expect((await ask({ executionId: "not-a-uuid", upstreams: [] })).status).toBe(422);
  });

  it("answers 401 to every request while the deployment has no shared secret", async () => {
    configure({ INGEST_SHARED_SECRET: "" });
    const { id } = await execution();

    expect((await ask({ executionId: id, upstreams: ["openrouter"] })).status).toBe(401);
  });

  it("answers 503 while the deployment has no seal public key, sending no key in the clear", async () => {
    configure({ INGEST_KEY_SEAL_PUBLIC_KEY: "" });
    const { id } = await execution();
    const res = await ask({ executionId: id, upstreams: ["openrouter"] });

    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(DEPLOYMENT_OPENROUTER);
  });

  it("counts requests under its config/rate-limits.yaml entry and answers 429 past it", async () => {
    configure();
    const { id } = await execution();
    const realIp = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await ask({ executionId: id, upstreams: ["openrouter"] }, { realIp })).status);

    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
