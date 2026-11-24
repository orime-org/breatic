// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The caller's side of the product's internal listener, for the suites that
 * drive it over a real socket (inner#1410 §4): the back office's credit-grant,
 * enterprise-membership and maintenance endpoints, the billing service's
 * commerce endpoints, and the gate in front of all of them. Not a test file:
 * the suites are `internal-api-*.integration.test.ts` and the other internal
 * listener suites that import it.
 *
 * The internal app is served by `@hono/node-server` on a loopback port,
 * because the rate limit keys on the connection's address
 * (`getConnInfo(c).remote.address`), which only a real socket has. Every
 * request is signed with `signRequest`, the function the back office mirrors,
 * over the exact bytes sent.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { env, getRedis, initCore, loadLocales, signRequest } from "@breatic/core";

/** The current shared secret the suites start the app with. */
export const SECRET = "internal-secret-current-0123456789abcdef";
/** The secret being rotated out; still accepted. */
export const PREVIOUS_SECRET = "internal-secret-previous-0123456789abcdef";
/** The back office admin id the requests carry. */
export const ADMIN = "admin_7";
/** The billing service's secret on this listener (inner#1993 §3.1). */
export const COMMERCE_SECRET = "commerce-secret-current-0123456789abcdef";

/** Point core at an environment with charging and the internal API on. */
export function initInternalCore(): void {
  initCore({
    ...process.env,
    CHARGING_ENABLED: "true",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: SECRET,
    INTERNAL_API_SECRET_PREVIOUS: PREVIOUS_SECRET,
    COMMERCE_API_SECRET: COMMERCE_SECRET,
  });
}

/** A running internal app. */
export interface RunningApp {
  baseUrl: string;
  close: () => Promise<void>;
  /** The listening server, for cases that watch its sockets. */
  server: Server;
}

/**
 * Serve an app on a loopback port.
 * @param app - The app.
 * @param listenPort - The port; 0 (the default) takes a free one.
 * @returns Its base URL, a closer and the server.
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
    server: server as Server,
  };
}

/** A fresh nonce in the allowed alphabet. */
export function freshNonce(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * A fresh labelled idempotency key, `bo-<label>-<uuid>`. The back office's
 * write endpoints accept only `bo-<uuid>`, so this is for requests whose key
 * the gate refuses or never reads.
 * @param label - The label after `bo-`.
 * @returns The key.
 */
export function freshKey(label = "op"): string {
  return `bo-${label}-${randomUUID()}`;
}

/** How one request is sent; anything left out is the honest value. */
export interface CallOptions {
  method?: "GET" | "POST" | "PUT";
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
 * Empty the internal listener's rate-limit buckets (`internal-api` and
 * `commerce-api`), so one case's requests never count against the next. All suites share one loopback address.
 */
export async function resetInternalRateLimit(): Promise<void> {
  const redis = getRedis();
  for (const name of ["internal-api", "commerce-api"]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${env.ENV}:ratelimit:${name}*`, "COUNT", 500);
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  }
}

/** What a suite reads inside its tests. */
export interface InternalSuite {
  sql: ReturnType<typeof postgres>;
  baseUrl: string;
  /** The internal app's listening server. */
  server: Server;
}

/**
 * Register a suite's setup: core with the internal API on, locales, a raw
 * SQL client, the internal app on a loopback port; before each case the
 * rate-limit buckets are cleared.
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
    holder.server = running.server;
  });
  afterAll(async () => {
    await running?.close();
    await holder.sql?.end({ timeout: 1 });
    initCore(process.env);
  });
  beforeEach(async () => {
    await resetInternalRateLimit();
  });
  return holder;
}

/**
 * The Redis key the nonce step stores (§4.2).
 * @param nonce - The nonce.
 * @returns The key.
 */
export function nonceKey(nonce: string): string {
  return `${env.ENV}:server:internal-nonce:${nonce}`;
}
