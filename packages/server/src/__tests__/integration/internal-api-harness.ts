// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The back office's side of the internal API, for the suites that drive it
 * over a real socket (inner#1410 §4). Not a test file: the suites are
 * `internal-api-*.integration.test.ts`.
 *
 * The internal app is served by `@hono/node-server` on a loopback port,
 * because the rate limit keys on the connection's address
 * (`getConnInfo(c).remote.address`), which only a real socket has. Every
 * request is signed with `signRequest`, the function the back office mirrors,
 * over the exact bytes sent.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, inject, vi } from "vitest";
import { env, getRedis, initCore, loadLocales } from "@breatic/core";
import { signRequest } from "@server/middleware/internal-signature.js";
import { fakeStripe } from "./fake-stripe-refunds.js";
import { expectOnlyRejudged, mailsOf, type SeededLot, type WorldState } from "./credit-refund-fixtures.js";

/** The current shared secret the suites start the app with. */
export const SECRET = "internal-secret-current-0123456789abcdef";
/** The secret being rotated out; still accepted. */
export const PREVIOUS_SECRET = "internal-secret-previous-0123456789abcdef";
/** The back office admin id the requests carry. */
export const ADMIN = "admin_7";

/**
 * Point core at an environment with payments and the internal API on.
 * Placeholder Stripe keys: every Stripe call goes to the injected fake.
 */
export function initInternalCore(): void {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: SECRET,
    INTERNAL_API_SECRET_PREVIOUS: PREVIOUS_SECRET,
  });
}

/** A running internal app. */
export interface RunningApp {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Serve an app on a loopback port.
 * @param app - The app.
 * @param listenPort - The port; 0 (the default) takes a free one.
 * @returns Its base URL and a closer.
 */
export async function serveOnLoopback(app: Hono, listenPort = 0): Promise<RunningApp> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: listenPort, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A fresh nonce in the allowed alphabet. */
export function freshNonce(): string {
  return randomBytes(18).toString("base64url");
}

/** A fresh idempotency key in `REFKEY_PATTERN`. */
export function freshKey(label = "op"): string {
  return `bo-${label}-${randomUUID()}`;
}

/** How one request is sent; anything left out is the honest value. */
export interface CallOptions {
  method?: "GET" | "POST";
  /** JSON body; sent as `JSON.stringify(body)` unless `rawBody` is given. */
  body?: unknown;
  /** Exact bytes to send (and sign, unless `signedBody` says otherwise). */
  rawBody?: string;
  idempotencyKey?: string | null;
  admin?: string;
  nonce?: string;
  /** Unix seconds put in the header and signed. */
  timestamp?: number;
  secret?: string;
  /** Sign this body instead of the one sent. */
  signedBody?: string;
  /** Sign this idempotency key instead of the one sent. */
  signedIdempotencyKey?: string | null;
  /** Replace or drop (undefined) any header after signing. */
  headerOverrides?: Record<string, string | undefined>;
  /** Send no signature headers at all. */
  unsigned?: boolean;
}

/** What came back. */
export interface CallResult {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read arbitrary JSON
  json: any;
  /** The exact request, for sending the same bytes again. */
  replay: () => Promise<CallResult>;
}

/**
 * Build the headers and body of one signed request.
 * @param path - Path with query, as sent.
 * @param opts - What to send.
 * @returns Method, headers, body.
 */
export function buildRequest(
  path: string,
  opts: CallOptions = {},
): { method: string; headers: Record<string, string>; body: string | undefined } {
  const method = opts.method ?? (opts.body !== undefined || opts.rawBody !== undefined ? "POST" : "GET");
  const body = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? freshNonce();
  const admin = opts.admin ?? ADMIN;
  const key = opts.idempotencyKey === undefined ? null : opts.idempotencyKey;
  const headers: Record<string, string> = {};
  if (body !== "") headers["content-type"] = "application/json";
  if (key !== null) headers["idempotency-key"] = key;
  if (!opts.unsigned) {
    headers["x-internal-admin"] = admin;
    headers["x-internal-timestamp"] = timestamp;
    headers["x-internal-nonce"] = nonce;
    headers["x-internal-signature"] = signRequest(opts.secret ?? SECRET, {
      method,
      pathWithQuery: path,
      timestamp,
      nonce,
      adminId: admin,
      idempotencyKey: opts.signedIdempotencyKey === undefined ? key : opts.signedIdempotencyKey,
      body: opts.signedBody ?? body,
    });
  }
  for (const [name, value] of Object.entries(opts.headerOverrides ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return { method, headers, body: body === "" ? undefined : body };
}

/**
 * Send one request to the internal app.
 * @param baseUrl - Where it listens.
 * @param path - Path with query.
 * @param opts - What to send.
 * @returns Status, headers, parsed JSON (null when the body is not JSON).
 */
export async function call(baseUrl: string, path: string, opts: CallOptions = {}): Promise<CallResult> {
  const req = buildRequest(path, opts);
  const send = async (): Promise<CallResult> => {
    const res = await fetch(`${baseUrl}${path}`, req);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json, replay: send };
  };
  return send();
}

/**
 * Empty the internal API's rate-limit buckets, so one case's requests never
 * count against the next. All suites share one loopback address.
 */
export async function resetInternalRateLimit(): Promise<void> {
  const redis = getRedis();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${env.ENV}:ratelimit:internal-api*`, "COUNT", 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

/** What a suite reads inside its tests. */
export interface InternalSuite {
  sql: ReturnType<typeof postgres>;
  baseUrl: string;
}

/**
 * Register a suite's setup: core with the internal API on, locales, a raw
 * SQL client, the internal app on a loopback port; before each case the fake
 * Stripe is emptied and the rate-limit buckets cleared.
 * @param appName - `application_name` for the suite's connections.
 * @returns A holder filled before the first case runs.
 */
export function useInternalApp(appName: string): InternalSuite {
  const holder = {} as InternalSuite;
  let running: RunningApp | undefined;
  beforeAll(async () => {
    initInternalCore();
    loadLocales();
    holder.sql = postgres(inject("DATABASE_URL"), {
      max: 8,
      prepare: false,
      connection: { application_name: appName },
    });
    const { createInternalApp } = await import("@server/internal-app.js");
    running = await serveOnLoopback(createInternalApp());
    holder.baseUrl = running.baseUrl;
  });
  afterAll(async () => {
    await running?.close();
    await holder.sql?.end({ timeout: 1 });
    initCore(process.env);
  });
  beforeEach(async () => {
    fakeStripe.reset();
    await resetInternalRateLimit();
  });
  return holder;
}

/**
 * Wait until every mail row of the lot has left `pending` and `sending`.
 * Rows are claimed and sent in the background right after the request
 * commits (§6.5 M1), so until then a row's status is still moving (a
 * snapshot taken now differs from one taken later), a same-key resend of a
 * `sending` row answers 409 request_in_progress, and a send still running
 * when the suite closes its connections fails its write-back.
 * @param sql - Raw client.
 * @param lot - The lot.
 */
export async function mailsSettled(sql: ReturnType<typeof postgres>, lot: SeededLot): Promise<void> {
  await vi.waitFor(
    async () => {
      const busy = (await mailsOf(sql, lot.lotId)).filter((m) => m.status === "pending" || m.status === "sending");
      expect(busy).toEqual([]);
    },
    { timeout: 10_000, interval: 20 },
  );
}

/**
 * The Redis key the nonce step stores (§4.2).
 * @param nonce - The nonce.
 * @returns The key.
 */
export function nonceKey(nonce: string): string {
  return `${env.ENV}:server:internal-nonce:${nonce}`;
}

/** Paths of the nine registered endpoints. */
export const paths = {
  preview: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund`,
  approve: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund/approve`,
  reject: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund/reject`,
  settle: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund/settle`,
  sendBack: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund/send-back`,
  retry: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund/retry`,
  resolvedOutside: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund/resolved-outside`,
  restoreCredits: (lotId: string) => `/internal/v1/credit-lots/${lotId}/refund/restore-credits`,
  resend: (operationId: string) => `/internal/v1/refund-operations/${operationId}/mail/resend`,
};

/**
 * Assert-friendly view of an error body: its code, and whether its detail
 * is a translated sentence rather than an untranslated `server.internal.*`
 * key or nothing at all.
 * @param json - The response body.
 * @returns The code, the reason (if any) and the detail check.
 */
export function errorShape(json: { code?: unknown; reason?: unknown; detail?: unknown } | null): {
  code: unknown;
  reason: unknown;
  detailTranslated: boolean;
} {
  const detail = json?.detail;
  return {
    code: json?.code,
    reason: json?.reason,
    detailTranslated: typeof detail === "string" && detail.length > 0 && !detail.startsWith("server."),
  };
}

/**
 * The dispositions and resend rows holding an idempotency key.
 * @param sql - Raw client.
 * @param key - The key.
 * @returns Counts in both tables.
 */
export async function holdersOf(sql: ReturnType<typeof postgres>, key: string): Promise<{ ops: number; mails: number }> {
  const [ops] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM credit_refund_operations WHERE idempotency_key = ${key}
  `;
  const [mails] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM refund_mail_outbox WHERE idempotency_key = ${key}
  `;
  return { ops: ops!.n, mails: mails!.n };
}

/**
 * Assert a 409 operation_in_progress that stored no disposition, held no
 * key and created no refund, the in-flight disposition keeping its status;
 * its re-judgement by the request's own Stripe read may add its event rows
 * (v6 §4.6, §6.4). The one definition every endpoint family's in-flight
 * refusal case uses.
 * @param sql - Raw client.
 * @param res - The answer.
 * @param lot - The lot.
 * @param before - The world before the request.
 * @param inFlightId - The disposition still in flight.
 * @param key - The request's idempotency key.
 */
export async function expectRefusedAroundInFlight(
  sql: ReturnType<typeof postgres>,
  res: CallResult,
  lot: SeededLot,
  before: WorldState,
  inFlightId: string,
  key: string,
): Promise<void> {
  expect(res.status).toBe(409);
  expect(errorShape(res.json)).toEqual({ code: "operation_in_progress", reason: undefined, detailTranslated: true });
  await expectOnlyRejudged(sql, lot, before, inFlightId);
  expect(await holdersOf(sql, key)).toEqual({ ops: 0, mails: 0 });
  expect(fakeStripe.createCalls).toEqual([]);
}
