// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Opening, disabling and enabling an influencer over the signed internal API
 * (inner#2157 design §7.6, §7.3 "网红启用停用时段", §8 rows "开网红接口" and
 * "停用不算分成" product part; acceptance V7, V12).
 *
 * `POST /internal/v1/influencers` `{ code, host }` and
 * `POST /internal/v1/influencers/:code/status` `{ enabled }` follow the
 * credit-grant endpoints: the back office's signature, a `bo-<uuid>`
 * idempotency key, the operator in the signed header, and every decision
 * (created, applied or refused) stored in `influencer_operations` under the
 * key and readable at `GET /internal/v1/influencer-operations/:key`. Same key
 * and same body replays the stored decision; same key with another body is
 * 409 `idempotency_conflict`.
 *
 * A host is accepted only as one lower-case label directly under
 * `partner.<cookieDomainHost()>`, after WHATWG URL normalisation (lower case,
 * punycode); anything else, or an empty `COOKIE_DOMAIN`, is refused as
 * `host_invalid`. A status change that really changes the state appends one
 * `influencer_status` event `{ code, enabled, changedAt }` to
 * `commerce_outbox` under `influencer:<code>` in the same transaction.
 *
 * Real PostgreSQL and Redis; the internal app on a loopback socket and the
 * public app in process.
 */

import { randomBytes, randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import { env, getRedis, initCore } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";
import { ADMIN, COMMERCE_SECRET, PREVIOUS_SECRET, SECRET, call, useInternalApp, type CallResult } from "./internal-api-harness.js";

const suite = useInternalApp("internal-api-influencers");

const OFFICIAL = "https://breatic.test";
const CREATE = "/internal/v1/influencers";

/**
 * Core with the internal API on, selling through a billing service, and the
 * region's site settings.
 * @param overrides - Environment values to change, e.g. `COOKIE_DOMAIN`.
 */
function initRegionInternalCore(overrides: Record<string, string> = {}): void {
  initCore({
    ...process.env,
    CHARGING_ENABLED: "true",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: SECRET,
    INTERNAL_API_SECRET_PREVIOUS: PREVIOUS_SECRET,
    COMMERCE_API_SECRET: COMMERCE_SECRET,
    COMMERCE_API_URL: "http://127.0.0.1:9",
    EMAIL_BACKEND: "disabled",
    ALLOWED_ORIGINS: OFFICIAL,
    COOKIE_DOMAIN: "breatic.test",
    ...overrides,
  });
}

beforeEach(() => {
  initRegionInternalCore();
});

/**
 * A key in the back office's format.
 * @returns `bo-<uuid>`.
 */
function freshKey(): string {
  return `bo-${randomUUID()}`;
}

/**
 * A code and a label nobody else in the database uses.
 * @returns Both.
 */
function fresh(): { code: string; label: string } {
  const t = randomBytes(5).toString("hex");
  return { code: `inf-${t}`, label: `l${t}` };
}

/**
 * The status endpoint of one code.
 * @param code - The influencer code.
 * @returns Its path.
 */
function statusPath(code: string): string {
  return `/internal/v1/influencers/${code}/status`;
}

/**
 * The stored-decision endpoint of one key.
 * @param key - The idempotency key.
 * @returns Its path.
 */
function operationPath(key: string): string {
  return `/internal/v1/influencer-operations/${key}`;
}

/**
 * Register an influencer.
 * @param body - Code and host.
 * @param body.code - The code.
 * @param body.host - The site host.
 * @param key - The idempotency key.
 * @returns The response.
 */
async function open(body: { code: string; host: string }, key = freshKey()): Promise<CallResult> {
  return call(suite.baseUrl, CREATE, { body, idempotencyKey: key, admin: ADMIN });
}

/**
 * Set an influencer's state.
 * @param code - The code.
 * @param enabled - The target state.
 * @param key - The idempotency key.
 * @returns The response.
 */
async function setStatus(code: string, enabled: boolean, key = freshKey()): Promise<CallResult> {
  return call(suite.baseUrl, statusPath(code), { body: { enabled }, idempotencyKey: key, admin: ADMIN });
}

/**
 * The stored influencer row, if any.
 * @param code - The code.
 * @returns Code, host and `disabled_at` as text.
 */
async function influencerRow(code: string): Promise<{ code: string; host: string | null; disabled_at: string | null }[]> {
  return suite.sql<{ code: string; host: string | null; disabled_at: string | null }[]>`
    SELECT code, host, disabled_at::text AS disabled_at FROM influencers WHERE code = ${code}`;
}

/**
 * How many decisions are stored under a key.
 * @param key - The key.
 * @returns The count.
 */
async function operationsUnder(key: string): Promise<number> {
  const [row] = await suite.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM influencer_operations WHERE key = ${key}`;
  return row!.n;
}

/**
 * The outbox events of one influencer, oldest first.
 * @param code - The code.
 * @returns Type and payload of each.
 */
async function statusEvents(code: string): Promise<Array<{ type: string; payload: { code: string; enabled: boolean; changedAt: string } }>> {
  return suite.sql<Array<{ type: string; payload: { code: string; enabled: boolean; changedAt: string } }>>`
    SELECT type, payload FROM commerce_outbox WHERE aggregate_key = ${`influencer:${code}`} ORDER BY seq`;
}

/**
 * Open a fresh, enabled influencer and assert it was created.
 * @returns Its code and host.
 */
async function opened(): Promise<{ code: string; host: string }> {
  const { code, label } = fresh();
  const host = `${label}.partner.breatic.test`;
  const res = await open({ code, host });
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ status: "created" });
  return { code, host };
}

/**
 * Assert a status change was accepted (not refused) and return its decision.
 * @param res - The response.
 * @returns The decision body.
 */
function accepted(res: CallResult): Record<string, unknown> {
  expect(res.status).toBe(200);
  expect(res.json.status).not.toBe("refused");
  expect(res.json.code).toBeUndefined();
  return res.json as Record<string, unknown>;
}

describe("POST /internal/v1/influencers", () => {
  it("V7 creates the influencer and stores its decision under the key", async () => {
    const { code, label } = fresh();
    const host = `${label}.partner.breatic.test`;
    const key = freshKey();
    const res = await open({ code, host }, key);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "created" });
    expect(await influencerRow(code)).toEqual([{ code, host, disabled_at: null }]);
    expect(await operationsUnder(key)).toBe(1);
    const stored = await call(suite.baseUrl, operationPath(key), { admin: ADMIN });
    expect(stored.status).toBe(200);
    expect(stored.json).toEqual(res.json);
  });

  it("refuses an unsigned request and one signed with an unknown secret, writing nothing", async () => {
    const { code, label } = fresh();
    const body = { code, host: `${label}.partner.breatic.test` };
    const key = freshKey();
    const unsigned = await call(suite.baseUrl, CREATE, { body, idempotencyKey: key, unsigned: true });
    expect(unsigned.status).toBe(401);
    const forged = await call(suite.baseUrl, CREATE, { body, idempotencyKey: key, admin: ADMIN, secret: "not-the-shared-secret-at-all-0000" });
    expect(forged.status).toBe(401);
    expect(await influencerRow(code)).toEqual([]);
    expect(await operationsUnder(key)).toBe(0);
  });

  it("refuses a request without a back-office key as invalid_body, writing nothing", async () => {
    const { code, label } = fresh();
    const res = await call(suite.baseUrl, CREATE, { body: { code, host: `${label}.partner.breatic.test` }, admin: ADMIN });
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ code: "invalid_body" });
    expect(await influencerRow(code)).toEqual([]);
  });

  it("replays the stored decision for the same key and body, and answers 409 for another body", async () => {
    const { code, label } = fresh();
    const host = `${label}.partner.breatic.test`;
    const key = freshKey();
    const first = await open({ code, host }, key);
    expect(first.json).toMatchObject({ status: "created" });
    const again = await open({ code, host }, key);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);

    const other = fresh();
    for (const body of [{ code: other.code, host }, { code, host: `${other.label}.partner.breatic.test` }]) {
      const conflict = await open(body, key);
      expect(conflict.status).toBe(409);
      expect(conflict.json).toEqual({ code: "idempotency_conflict" });
    }
    expect(await influencerRow(other.code)).toEqual([]);
    expect(await operationsUnder(key)).toBe(1);
  });

  it("serialises twenty identical requests into one influencer and one decision", async () => {
    const { code, label } = fresh();
    const key = freshKey();
    const body = { code, host: `${label}.partner.breatic.test` };
    const responses = await Promise.all(Array.from({ length: 20 }, () => open(body, key)));
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.json).toEqual(responses[0]!.json);
    }
    expect(responses[0]!.json).toMatchObject({ status: "created" });
    expect(await influencerRow(code)).toHaveLength(1);
    expect(await operationsUnder(key)).toBe(1);
  });

  it("decides concurrent opens of one code under different keys as one created and the rest code_taken, storing every decision", async () => {
    const { code, label } = fresh();
    const keys = Array.from({ length: 6 }, () => freshKey());
    const responses = await Promise.all(keys.map((key, i) => open({ code, host: `${label}${i}.partner.breatic.test` }, key)));

    for (const res of responses) expect(res.status).toBe(200);
    expect(responses.filter((r) => r.json.status === "created")).toHaveLength(1);
    expect(responses.filter((r) => r.json.status === "refused").map((r) => r.json.code)).toEqual(Array(5).fill("code_taken"));
    for (const key of keys) expect(await operationsUnder(key)).toBe(1);
  });

  it("decides concurrent opens of one host under different keys as one created and the rest host_taken", async () => {
    const { label } = fresh();
    const host = `${label}.partner.breatic.test`;
    const responses = await Promise.all(Array.from({ length: 6 }, () => open({ code: fresh().code, host })));

    for (const res of responses) expect(res.status).toBe(200);
    expect(responses.filter((r) => r.json.status === "created")).toHaveLength(1);
    expect(responses.filter((r) => r.json.status === "refused").map((r) => r.json.code)).toEqual(Array(5).fill("host_taken"));
  });

  it("answers 404 not_found for a key that holds no decision", async () => {
    const res = await call(suite.baseUrl, operationPath(freshKey()), { admin: ADMIN });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ code: "not_found" });
  });

  it.each([
    ["one level under the main domain", (l: string) => `${l}.breatic.test`],
    ["two labels under partner", (l: string) => `x.${l}.partner.breatic.test`],
    ["another domain", (l: string) => `${l}.partner.example.com`],
    ["partner.<domain> itself", (_l: string) => "partner.breatic.test"],
    ["a label with an underscore", (l: string) => `${l}_x.partner.breatic.test`],
    ["a label starting with a hyphen", (l: string) => `-${l}.partner.breatic.test`],
    ["a label ending with a hyphen", (l: string) => `${l}-.partner.breatic.test`],
  ])("refuses %s as host_invalid, stores the refusal and replays it", async (_name, hostOf) => {
    const { code, label } = fresh();
    const key = freshKey();
    const body = { code, host: hostOf(label) };
    const res = await open(body, key);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "refused", code: "host_invalid" });
    expect(await influencerRow(code)).toEqual([]);
    expect(await operationsUnder(key)).toBe(1);
    const replay = await open(body, key);
    expect(replay.json).toEqual(res.json);
    expect((await call(suite.baseUrl, operationPath(key), { admin: ADMIN })).json).toEqual(res.json);
  });

  it("refuses every host as host_invalid while COOKIE_DOMAIN is empty", async () => {
    initRegionInternalCore({ COOKIE_DOMAIN: "" });
    const { code, label } = fresh();
    const res = await open({ code, host: `${label}.partner.breatic.test` });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "refused", code: "host_invalid" });
    expect(await influencerRow(code)).toEqual([]);
  });

  it("accepts the host when COOKIE_DOMAIN carries a leading dot, upper case and spaces", async () => {
    initRegionInternalCore({ COOKIE_DOMAIN: " .Breatic.test " });
    const { code, label } = fresh();
    const host = `${label}.partner.breatic.test`;
    const res = await open({ code, host });
    expect(res.json).toMatchObject({ status: "created" });
    expect(await influencerRow(code)).toEqual([{ code, host, disabled_at: null }]);
  });

  it("stores an upper-case host in lower case", async () => {
    const { code, label } = fresh();
    const res = await open({ code, host: `${label.toUpperCase()}.Partner.Breatic.TEST` });
    expect(res.json).toMatchObject({ status: "created" });
    expect(await influencerRow(code)).toEqual([{ code, host: `${label}.partner.breatic.test`, disabled_at: null }]);
  });

  it("stores a Unicode host as the punycode a browser's Origin parses to", async () => {
    const { code, label } = fresh();
    const unicode = `bü${label}.partner.breatic.test`;
    const res = await open({ code, host: unicode });
    expect(res.json).toMatchObject({ status: "created" });
    const asOrigin = new URL(`https://${unicode}`).hostname;
    expect(asOrigin.startsWith("xn--")).toBe(true);
    expect(await influencerRow(code)).toEqual([{ code, host: asOrigin, disabled_at: null }]);
  });

  it("refuses a taken code as code_taken and a taken host as host_taken, keeping the first owner", async () => {
    const first = await opened();
    const other = fresh();

    const codeKey = freshKey();
    const sameCode = await open({ code: first.code, host: `${other.label}.partner.breatic.test` }, codeKey);
    expect(sameCode.status).toBe(200);
    expect(sameCode.json).toMatchObject({ status: "refused", code: "code_taken" });
    expect(await operationsUnder(codeKey)).toBe(1);

    const hostKey = freshKey();
    const sameHost = await open({ code: other.code, host: first.host }, hostKey);
    expect(sameHost.status).toBe(200);
    expect(sameHost.json).toMatchObject({ status: "refused", code: "host_taken" });
    expect(await operationsUnder(hostKey)).toBe(1);

    expect(await influencerRow(first.code)).toEqual([{ code: first.code, host: first.host, disabled_at: null }]);
    expect(await influencerRow(other.code)).toEqual([]);
  });

  it("refuses the official code as code_taken", async () => {
    const { label } = fresh();
    const res = await open({ code: "official", host: `${label}.partner.breatic.test` });
    expect(res.json).toMatchObject({ status: "refused", code: "code_taken" });
    expect(await influencerRow("official")).toEqual([{ code: "official", host: null, disabled_at: null }]);
  });

  it("refuses a disabled influencer's code and host: a disabled row still holds both", async () => {
    const first = await opened();
    accepted(await setStatus(first.code, false));
    const other = fresh();
    expect((await open({ code: first.code, host: `${other.label}.partner.breatic.test` })).json).toMatchObject({ status: "refused", code: "code_taken" });
    expect((await open({ code: other.code, host: first.host })).json).toMatchObject({ status: "refused", code: "host_taken" });
  });
});

describe("POST /internal/v1/influencers/:code/status", () => {
  it("V12 disabling sets disabled_at and appends one influencer_status event carrying that instant", async () => {
    const { code } = await opened();
    const key = freshKey();
    const decision = accepted(await setStatus(code, false, key));
    const [row] = await influencerRow(code);
    expect(row!.disabled_at).not.toBeNull();
    const events = await statusEvents(code);
    expect(events).toEqual([{ type: "influencer_status", payload: { code, enabled: false, changedAt: expect.any(String) } }]);
    const [same] = await suite.sql<{ same: boolean }[]>`
      SELECT (${events[0]!.payload.changedAt}::timestamptz = disabled_at) AS same FROM influencers WHERE code = ${code}`;
    expect(same!.same).toBe(true);
    expect(await operationsUnder(key)).toBe(1);
    expect((await call(suite.baseUrl, operationPath(key), { admin: ADMIN })).json).toEqual(decision);
  });

  it("a repeated disable succeeds, keeps disabled_at and appends nothing", async () => {
    const { code } = await opened();
    accepted(await setStatus(code, false));
    const [before] = await influencerRow(code);
    accepted(await setStatus(code, false));
    expect(await influencerRow(code)).toEqual([before]);
    expect(await statusEvents(code)).toHaveLength(1);
  });

  it("enabling clears disabled_at and appends one enabled event after the disabled one", async () => {
    const { code, host } = await opened();
    accepted(await setStatus(code, false));
    accepted(await setStatus(code, true));
    expect(await influencerRow(code)).toEqual([{ code, host, disabled_at: null }]);
    const events = await statusEvents(code);
    expect(events.map((e) => [e.type, e.payload.code, e.payload.enabled])).toEqual([
      ["influencer_status", code, false],
      ["influencer_status", code, true],
    ]);
    expect(new Date(events[1]!.payload.changedAt).getTime()).toBeGreaterThanOrEqual(new Date(events[0]!.payload.changedAt).getTime());
  });

  it("enabling an influencer that is already enabled succeeds and appends nothing", async () => {
    const { code, host } = await opened();
    accepted(await setStatus(code, true));
    expect(await influencerRow(code)).toEqual([{ code, host, disabled_at: null }]);
    expect(await statusEvents(code)).toEqual([]);
  });

  it("refuses a code nobody registered as code_unknown and stores the refusal", async () => {
    const { code } = fresh();
    const key = freshKey();
    const res = await setStatus(code, false, key);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "refused", code: "code_unknown" });
    expect(await operationsUnder(key)).toBe(1);
    expect(await statusEvents(code)).toEqual([]);
  });

  it("refuses the official code as code_official and leaves it enabled", async () => {
    const key = freshKey();
    const res = await setStatus("official", false, key);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "refused", code: "code_official" });
    expect(await influencerRow("official")).toEqual([{ code: "official", host: null, disabled_at: null }]);
    expect(await statusEvents("official")).toEqual([]);
    expect(await operationsUnder(key)).toBe(1);
  });

  it("replays the same key and body, and answers 409 to the same key with the other state", async () => {
    const { code } = await opened();
    const key = freshKey();
    const first = accepted(await setStatus(code, false, key));
    const again = await setStatus(code, false, key);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first);
    const conflict = await setStatus(code, true, key);
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({ code: "idempotency_conflict" });
    expect((await influencerRow(code))[0]!.disabled_at).not.toBeNull();
    expect(await statusEvents(code)).toHaveLength(1);
  });

  it("refuses an unsigned status change, changing nothing", async () => {
    const { code, host } = await opened();
    const res = await call(suite.baseUrl, statusPath(code), { body: { enabled: false }, idempotencyKey: freshKey(), unsigned: true });
    expect(res.status).toBe(401);
    expect(await influencerRow(code)).toEqual([{ code, host, disabled_at: null }]);
    expect(await statusEvents(code)).toEqual([]);
  });

  it("ten concurrent disables under one key append exactly one event", async () => {
    const { code } = await opened();
    const key = freshKey();
    const responses = await Promise.all(Array.from({ length: 10 }, () => setStatus(code, false, key)));
    for (const res of responses) expect(res.json).toEqual(accepted(responses[0]!));
    expect(await statusEvents(code)).toHaveLength(1);
  });

  it("ten concurrent disables under different keys append exactly one event", async () => {
    const { code } = await opened();
    const responses = await Promise.all(Array.from({ length: 10 }, () => setStatus(code, false)));
    for (const res of responses) accepted(res);
    expect(await statusEvents(code)).toHaveLength(1);
  });

  it("appends nothing while the deployment sells nothing, but still disables", async () => {
    initRegionInternalCore({ COMMERCE_API_URL: "" });
    const { code } = await opened();
    accepted(await setStatus(code, false));
    expect((await influencerRow(code))[0]!.disabled_at).not.toBeNull();
    expect(await statusEvents(code)).toEqual([]);
  });

  it("property: the outbox holds exactly one event per real change, in order", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), async (targets) => {
        const { code } = await opened();
        let state = true;
        const changes: boolean[] = [];
        for (const enabled of targets) {
          accepted(await setStatus(code, enabled));
          if (enabled !== state) changes.push(enabled);
          state = enabled;
        }
        const events = await statusEvents(code);
        expect(events.map((e) => e.payload.enabled)).toEqual(changes);
        expect(events.every((e) => e.type === "influencer_status" && e.payload.code === code)).toBe(true);
        const [row] = await influencerRow(code);
        expect(row!.disabled_at === null).toBe(state);
      }),
      { seed: 2157, numRuns: 6 },
    );
  });
});

describe("an influencer opened, disabled and enabled through the API, seen from its site (V7, V12)", () => {
  let app: Hono;
  let influencer: { code: string; host: string };

  beforeAll(async () => {
    initRegionInternalCore();
    // Opened before the public app's first request: the trusted-origin host list is cached per process.
    influencer = await opened();
    const { createApp } = await import("@server/app.js");
    app = withPeer(createApp());
  });

  afterAll(async () => {
    const keys = await getRedis().keys(`${env.ENV}:ratelimit:register*`);
    if (keys.length > 0) await getRedis().del(...keys);
  });

  /**
   * Create an account from the influencer's site.
   * @returns The new account's recorded code.
   */
  async function signUpFromSite(): Promise<string> {
    const email = `influencer-api-${randomUUID()}@example.test`;
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `https://${influencer.host}` },
      body: JSON.stringify({ email, password: "password1" }),
    });
    expect(res.status).toBe(201);
    const [row] = await suite.sql<{ influencer_code: string }[]>`
      SELECT influencer_code FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    await suite.sql`UPDATE users SET deleted_at = now() WHERE email = ${email}`;
    return row!.influencer_code;
  }

  /**
   * A CORS preflight from the influencer's site.
   * @returns The allowed origin the server answered, or null.
   */
  async function preflightAllowedOrigin(): Promise<string | null> {
    const res = await app.request("/api/v1/auth/me", {
      method: "OPTIONS",
      headers: { Origin: `https://${influencer.host}`, "Access-Control-Request-Method": "GET" },
    });
    return res.headers.get("access-control-allow-origin");
  }

  it("records new accounts under the influencer, official while disabled and the influencer again once enabled", async () => {
    expect(await signUpFromSite()).toBe(influencer.code);
    accepted(await setStatus(influencer.code, false));
    expect(await signUpFromSite()).toBe("official");
    accepted(await setStatus(influencer.code, true));
    expect(await signUpFromSite()).toBe(influencer.code);
  });

  it("keeps the site's CORS open while the influencer is disabled", async () => {
    expect(await preflightAllowedOrigin()).toBe(`https://${influencer.host}`);
    accepted(await setStatus(influencer.code, false));
    expect(await preflightAllowedOrigin()).toBe(`https://${influencer.host}`);
    accepted(await setStatus(influencer.code, true));
  });

  it("leaves accounts already recorded under the influencer where they are when it is disabled", async () => {
    const email = `influencer-api-${randomUUID()}@example.test`;
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `https://${influencer.host}` },
      body: JSON.stringify({ email, password: "password1" }),
    });
    expect(res.status).toBe(201);
    accepted(await setStatus(influencer.code, false));
    const rows = await suite.sql<{ influencer_code: string }[]>`
      SELECT influencer_code FROM users WHERE email = ${email} AND deleted_at IS NULL`;
    expect(rows).toEqual([{ influencer_code: influencer.code }]);
    await suite.sql`UPDATE users SET deleted_at = now() WHERE email = ${email}`;
    accepted(await setStatus(influencer.code, true));
  });
});
