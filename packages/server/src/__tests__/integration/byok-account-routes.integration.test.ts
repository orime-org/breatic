// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The account's bring-your-own-key settings over HTTP (inner#1953): `GET /api/v1/account/byok`, saving, re-checking
 * and deleting a key under `/keys/:upstream`, and pointing a media model at an upstream under `/models/:model`.
 *
 * The pins: every route is behind auth and acts on the caller's own account; a key is checked before it is saved and
 * a refused or malformed one saves nothing; no answer and no log line ever carries the key or its sealed text, only
 * its display hint; replacing or deleting a key clears the old row's sealed text at once; a language-model key goes
 * only to OpenRouter; a model can only be pointed at an upstream holding a live key that can run it, and never a
 * language model. Without the deployment's master keys, saving answers 503.
 *
 * `provider().checkKey` is stubbed at the provider instance: what each upstream answers is provider's to pin
 * (`packages/provider/src/__tests__/check-key.integration.test.ts`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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

import crypto, { randomBytes } from "node:crypto";
import postgres from "postgres";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { MONOREPO_ROOT, accountModelUpstreamsRepo, createLogger, getRedis, initCore, initLogger, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import { initProvider } from "@breatic/domain";
import type { Hono } from "hono";

const SECRET = randomBytes(32);
/** The environment with this deployment's master keys for sealing account keys. */
const BYOK_ENV = {
  ...process.env,
  PROVIDER_KEY_SECRET_ID: "t1",
  PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }),
};

/** A media model bound on WaveSpeed, fal and SandBase. */
const MODEL = "gpt-image-2.5-sunburst-text-to-image";
/** A media model bound on WaveSpeed alone. */
const WAVESPEED_ONLY = "ideogram-v3-quality";
/** A language model of `config/provider/llm.yaml`. */
const LLM_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/** The media bindings the upstream list is drawn from. */
const MEDIA_CONFIG = resolve(MONOREPO_ROOT, "config/provider/media");

/** What a check answers, as provider's `checkKey` does. */
type Checked = { connected: boolean; balance?: unknown; reason?: string };
const checkKey = vi.fn<(upstream: string, key: string) => Promise<Checked>>();

/** Where this suite's logs go, read back to prove no key reached them. */
const LOGS_ROOT = mkdtempSync(join(tmpdir(), "byok-account-routes-logs-"));

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  initCore(BYOK_ENV);
  loadLocales();
  // A real pino instance writing synchronously to files, so every line any logger of this process writes can be read back.
  initLogger("byok-account-routes-test", { logsRoot: LOGS_ROOT, debug: true, console: "none" });
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "byok-account-routes-test" } });
  const real = initProvider();
  initProvider(new Proxy(real, { get: (target, prop, receiver) => (prop === "checkKey" ? checkKey : Reflect.get(target, prop, receiver)) }));
  // Imported after initCore ran: `@server/app.js` pulls cors.ts, which reads `env.ALLOWED_ORIGINS` while the module evaluates.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(() => {
  checkKey.mockReset();
  checkKey.mockImplementation(async () => ({ connected: true, balance: { amount: 12.34, currency: "USD" } }));
});

/**
 * A fresh verified account, signed in.
 * @returns Its id and a Cookie header for it.
 */
async function signedIn(): Promise<{ userId: string; cookie: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`byok-route-${crypto.randomUUID().slice(0, 8)}@test.local`}, true) RETURNING id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  return { userId: user!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * A key no answer could contain by chance.
 * @param prefix - Its first characters, as the upstream's keys begin.
 * @returns The key.
 */
const freshKey = (prefix = "sk-or-v1-"): string => `${prefix}${crypto.randomBytes(16).toString("hex")}`;

/**
 * The hint the account sees for a key: its first six and last four characters.
 * @param key - The key.
 * @returns The hint.
 */
const hintOf = (key: string): string => `${key.slice(0, 6)}…${key.slice(-4)}`;

/**
 * Send a request as an account.
 * @param cookie - The account's Cookie header.
 * @param method - The HTTP method.
 * @param path - The path under `/api/v1/account/byok`.
 * @param body - The JSON body, if any.
 * @returns The response.
 */
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/v1/account/byok${path}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Save a key through the route.
 * @param cookie - The account's Cookie header.
 * @param upstream - The upstream.
 * @param key - The key.
 * @returns The response.
 */
const putKey = (cookie: string, upstream: string, key: string): Promise<Response> => call(cookie, "PUT", `/keys/${upstream}`, { key });

/**
 * Point a model at an upstream, or back at the deployment's keys.
 * @param cookie - The account's Cookie header.
 * @param model - The model.
 * @param upstream - The upstream, or null.
 * @returns The response.
 */
const putModel = (cookie: string, model: string, upstream: string | null): Promise<Response> =>
  call(cookie, "PUT", `/models/${encodeURIComponent(model)}`, { upstream });

/** The settings the account sees. */
interface Settings {
  enabled: boolean;
  upstreams: { upstream: string; name: string; kind: "llm" | "official" | "reseller"; keyUrl: string | null }[];
  keys: { upstream: string; displayHint: string; lastConnected: boolean; lastBalanceState?: string | null; lastBalanceAmount?: unknown; lastFailure?: string | null }[];
  models: { model: string; upstream: string }[];
  choices: Record<string, string[]>;
}

/**
 * Read the account's settings and the raw text they came in.
 * @param cookie - The account's Cookie header.
 * @returns The settings and the body's text.
 */
async function settings(cookie: string): Promise<{ data: Settings; text: string }> {
  const res = await call(cookie, "GET", "");
  expect(res.status).toBe(200);
  const text = await res.text();
  return { data: (JSON.parse(text) as { data: Settings }).data, text };
}

/**
 * Every key row an account has, retired or not, straight from the table.
 * @param userId - The account.
 * @returns The rows, oldest first.
 */
async function keyRows(userId: string): Promise<{ id: string; upstream: string; ciphertext: string | null; deleted_at: Date | null }[]> {
  return sql`SELECT id, upstream, ciphertext, deleted_at FROM account_provider_keys WHERE user_id = ${userId} ORDER BY created_at, id`;
}

/**
 * Everything this process has logged so far, child loggers included, as the log files hold it.
 * @returns The files' text.
 */
function loggedText(): string {
  return readdirSync(LOGS_ROOT, { recursive: true, encoding: "utf8" })
    .map((name) => join(LOGS_ROOT, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

/**
 * Watch every log line written while a step runs.
 * @returns The text of every line logged since.
 */
function watchLogs(): () => string {
  const before = loggedText().length;
  return () => loggedText().slice(before);
}

describe("the BYOK routes' gate", () => {
  it.each([
    ["GET", ""],
    ["PUT", "/keys/openrouter"],
    ["POST", "/keys/openrouter/check"],
    ["DELETE", "/keys/openrouter"],
    ["PUT", `/models/${MODEL}`],
  ])("refuses an unauthenticated %s %s", async (method, path) => {
    const res = await app.request(`/api/v1/account/byok${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "PUT" ? { body: JSON.stringify({ key: freshKey(), upstream: "fal" }) } : {}),
    });
    expect(res.status).toBe(401);
    expect(checkKey).not.toHaveBeenCalled();
  });
});

describe("PUT /api/v1/account/byok/keys/:upstream", () => {
  it("checks the key, then saves it sealed and answers only its hint", async () => {
    const { userId, cookie } = await signedIn();
    const key = freshKey();

    const res = await putKey(cookie, "openrouter", key);

    expect(res.status).toBe(200);
    expect(checkKey).toHaveBeenCalledExactlyOnceWith("openrouter", key);
    const text = await res.text();
    const body = JSON.parse(text) as { data: Settings["keys"][number] };
    expect(body.data).toMatchObject({ upstream: "openrouter", displayHint: hintOf(key), lastConnected: true });
    const [row] = await keyRows(userId);
    expect(row!.ciphertext).toMatch(/^v1:t1:/);
    expect(row!.ciphertext).not.toContain(key);
    expect(text).not.toContain(key);
    expect(text).not.toContain(row!.ciphertext!);
    expect(text).not.toMatch(/ciphertext/i);
  });

  it("trims the whitespace a paste brings before checking", async () => {
    const { cookie } = await signedIn();
    const key = freshKey();

    expect((await putKey(cookie, "openrouter", `  ${key}\n`)).status).toBe(200);
    expect(checkKey).toHaveBeenCalledExactlyOnceWith("openrouter", key);
  });

  it("answers 422 with the reason when the check fails, and saves nothing", async () => {
    const { userId, cookie } = await signedIn();
    const key = freshKey("fal-");
    checkKey.mockImplementation(async () => ({ connected: false, reason: "invalid" }));

    const res = await putKey(cookie, "fal", key);

    expect(res.status).toBe(422);
    const text = await res.text();
    expect((JSON.parse(text) as { error: { reason?: unknown } }).error.reason).toEqual(expect.any(String));
    expect(text).not.toContain(key);
    expect(await keyRows(userId)).toEqual([]);
    expect((await settings(cookie)).data.keys).toEqual([]);
  });

  it.each([
    ["a line break inside", (k: string) => `${k.slice(0, 10)}\n${k.slice(10)}`],
    ["a control character inside", (k: string) => `${k.slice(0, 10)}\u001b${k.slice(10)}`],
    ["a space inside", (k: string) => `${k.slice(0, 10)} ${k.slice(10)}`],
    ["a character that is not ASCII", (k: string) => `${k.slice(0, 10)}é${k.slice(10)}`],
    ["more than 1024 characters", (k: string) => k.padEnd(1025, "x")],
  ])("refuses a key with %s with 422, unchecked and unsaved, repeating it nowhere", async (_label, malform) => {
    const { userId, cookie } = await signedIn();
    const key = malform(freshKey());
    const logs = watchLogs();

    const res = await putKey(cookie, "openrouter", key);

    expect(res.status).toBe(422);
    expect(checkKey).not.toHaveBeenCalled();
    expect(await keyRows(userId)).toEqual([]);
    const text = await res.text();
    const logged = logs();
    for (const part of [key, key.slice(0, 20), key.slice(-20)]) {
      expect(text).not.toContain(part);
      expect(logged).not.toContain(part);
    }
  });

  it("logs nothing of the key while checking and saving it", async () => {
    const { cookie } = await signedIn();
    const key = freshKey();
    const logs = watchLogs();
    checkKey.mockImplementation(async () => ({ connected: false, reason: "invalid" }));

    expect((await putKey(cookie, "openrouter", key)).status).toBe(422);
    checkKey.mockImplementation(async () => ({ connected: true, balance: "unsupported" }));
    expect((await putKey(cookie, "openrouter", key)).status).toBe(200);

    // The capture sees a component logger's lines, so the absence above is not an empty file's.
    const probe = crypto.randomUUID();
    createLogger("byok-test-probe").info({ probe }, "byok_log_probe");
    const logged = logs();
    expect(logged).toContain(probe);
    expect(logged).not.toContain(key);
  });

  it.each(["anthropic", "google", "openai", "not-an-upstream"])("takes no key for %s: a language-model key goes only to OpenRouter", async (upstream) => {
    const { userId, cookie } = await signedIn();

    const res = await putKey(cookie, upstream, freshKey());

    expect(res.status).toBe(422);
    expect(checkKey).not.toHaveBeenCalled();
    expect(await keyRows(userId)).toEqual([]);
  });

  it("replaces a key: the new one is checked and saved, the old row's sealed text cleared at once", async () => {
    const { userId, cookie } = await signedIn();
    const oldKey = freshKey("fal-");
    const newKey = freshKey("fal-");
    expect((await putKey(cookie, "fal", oldKey)).status).toBe(200);

    const res = await putKey(cookie, "fal", newKey);

    expect(res.status).toBe(200);
    expect(checkKey).toHaveBeenLastCalledWith("fal", newKey);
    const rows = await keyRows(userId);
    expect(rows.map((r) => [r.ciphertext === null, r.deleted_at === null])).toEqual([
      [true, false],
      [false, true],
    ]);
    const { data, text } = await settings(cookie);
    expect(data.keys.map((k) => [k.upstream, k.displayHint])).toEqual([["fal", hintOf(newKey)]]);
    expect(text).not.toContain(oldKey);
    expect(text).not.toContain(newKey);
  });

  it("keeps the old key untouched when the replacing key fails its check", async () => {
    const { userId, cookie } = await signedIn();
    const oldKey = freshKey("fal-");
    expect((await putKey(cookie, "fal", oldKey)).status).toBe(200);
    const before = await keyRows(userId);
    checkKey.mockImplementation(async () => ({ connected: false, reason: "invalid" }));

    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(422);

    expect(await keyRows(userId)).toEqual(before);
    expect((await settings(cookie)).data.keys.map((k) => k.displayHint)).toEqual([hintOf(oldKey)]);
  });
});

describe("POST /api/v1/account/byok/keys/:upstream/check", () => {
  it("checks the saved key again and records what it found", async () => {
    const { cookie } = await signedIn();
    const key = freshKey("ws-");
    checkKey.mockImplementation(async () => ({ connected: true, balance: { amount: 1, currency: "USD" } }));
    expect((await putKey(cookie, "wavespeed", key)).status).toBe(200);
    checkKey.mockReset();
    checkKey.mockImplementation(async () => ({ connected: true, balance: { amount: 12.34, currency: "USD" } }));

    const res = await call(cookie, "POST", "/keys/wavespeed/check");

    expect(res.status).toBe(200);
    expect(checkKey).toHaveBeenCalledExactlyOnceWith("wavespeed", key);
    const text = await res.text();
    expect(text).not.toContain(key);
    const [entry] = (await settings(cookie)).data.keys;
    expect(entry).toMatchObject({ upstream: "wavespeed", lastConnected: true, lastBalanceState: "known" });
    expect(Number(entry!.lastBalanceAmount)).toBe(12.34);
  });

  it("keeps a key that no longer connects, marked as not connected with the reason", async () => {
    const { userId, cookie } = await signedIn();
    expect((await putKey(cookie, "sandbase", freshKey("sb-"))).status).toBe(200);
    checkKey.mockImplementation(async () => ({ connected: false, reason: "invalid" }));

    expect((await call(cookie, "POST", "/keys/sandbase/check")).status).toBe(200);

    const [entry] = (await settings(cookie)).data.keys;
    // A reason code the web translates, never a sentence.
    expect(entry).toMatchObject({ upstream: "sandbase", lastConnected: false, lastFailure: "invalid" });
    expect((await keyRows(userId)).filter((r) => r.deleted_at === null && r.ciphertext !== null)).toHaveLength(1);
  });

  it("answers 404 when the account holds no key for that upstream", async () => {
    const { cookie } = await signedIn();

    expect((await putKey(cookie, "wavespeed", freshKey("ws-"))).status).toBe(200);
    checkKey.mockClear();

    expect((await call(cookie, "POST", "/keys/fal/check")).status).toBe(404);
    expect(checkKey).not.toHaveBeenCalled();
    // The same route answers for an upstream the account does hold a key for.
    expect((await call(cookie, "POST", "/keys/wavespeed/check")).status).toBe(200);
  });
});

describe("DELETE /api/v1/account/byok/keys/:upstream", () => {
  it("clears the sealed text, retires the row and drops only the model choices naming that upstream", async () => {
    const { userId, cookie } = await signedIn();
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);
    expect((await putKey(cookie, "wavespeed", freshKey("ws-"))).status).toBe(200);
    expect((await putModel(cookie, MODEL, "fal")).status).toBe(200);
    expect((await putModel(cookie, WAVESPEED_ONLY, "wavespeed")).status).toBe(200);

    const res = await call(cookie, "DELETE", "/keys/fal");

    expect(res.ok).toBe(true);
    const fal = (await keyRows(userId)).filter((r) => r.upstream === "fal");
    expect(fal).toHaveLength(1);
    expect(fal[0]).toMatchObject({ ciphertext: null });
    expect(fal[0]!.deleted_at).not.toBeNull();
    const { data } = await settings(cookie);
    expect(data.keys.map((k) => k.upstream)).toEqual(["wavespeed"]);
    expect(data.models).toEqual([{ model: WAVESPEED_ONLY, upstream: "wavespeed" }]);
  });

  it("answers 404 when there is no key to delete", async () => {
    const { cookie } = await signedIn();

    expect((await putKey(cookie, "wavespeed", freshKey("ws-"))).status).toBe(200);

    expect((await call(cookie, "DELETE", "/keys/fal")).status).toBe(404);
    // The same route deletes a key the account does hold.
    expect((await call(cookie, "DELETE", "/keys/wavespeed")).ok).toBe(true);
  });
});

describe("GET /api/v1/account/byok", () => {
  it("answers an account with nothing saved: on, no keys, no choices", async () => {
    const { cookie } = await signedIn();

    const { data } = await settings(cookie);

    expect(data.enabled).toBe(true);
    expect(data.keys).toEqual([]);
    expect(data.models).toEqual([]);
    expect(Object.values(data.choices).flat()).toEqual([]);
  });

  it("offers each media model the upstreams holding a key that can run it, and no language model", async () => {
    const { cookie } = await signedIn();
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);
    expect((await putKey(cookie, "openrouter", freshKey())).status).toBe(200);

    let { data } = await settings(cookie);
    expect(data.choices[MODEL]).toEqual(["fal"]);
    expect(data.choices[WAVESPEED_ONLY] ?? []).toEqual([]);
    expect(data.choices[LLM_MODEL]).toBeUndefined();
    expect(Object.values(data.choices).flat()).not.toContain("openrouter");

    expect((await putKey(cookie, "wavespeed", freshKey("ws-"))).status).toBe(200);
    ({ data } = await settings(cookie));
    expect([...(data.choices[MODEL] ?? [])].sort()).toEqual(["fal", "wavespeed"]);
    expect(data.choices[WAVESPEED_ONLY]).toEqual(["wavespeed"]);
  });

  it("never answers a key or a sealed text, only hints", async () => {
    const { userId, cookie } = await signedIn();
    const keys = { openrouter: freshKey(), fal: freshKey("fal-"), wavespeed: freshKey("ws-"), sandbase: freshKey("sb-") };
    for (const [upstream, key] of Object.entries(keys)) expect((await putKey(cookie, upstream, key)).status).toBe(200);

    const { data, text } = await settings(cookie);

    expect(data.keys.map((k) => k.displayHint).sort()).toEqual(Object.values(keys).map(hintOf).sort());
    for (const key of Object.values(keys)) expect(text).not.toContain(key);
    for (const row of await keyRows(userId)) expect(text).not.toContain(row.ciphertext!);
    expect(text).not.toMatch(/ciphertext/i);
  });

  it("lists the upstreams a key can be added for: OpenRouter and every upstream a media model is bound on, from config", async () => {
    const { cookie } = await signedIn();

    const { data } = await settings(cookie);

    const bound = new Set<string>(["openrouter"]);
    for (const file of readdirSync(MEDIA_CONFIG).filter((name) => name.endsWith(".yaml"))) {
      const parsed = parseYaml(readFileSync(join(MEDIA_CONFIG, file), "utf8")) as { models?: Record<string, { upstreams?: { upstream: string }[] }> };
      for (const model of Object.values(parsed.models ?? {})) for (const binding of model.upstreams ?? []) bound.add(binding.upstream);
    }
    expect(data.upstreams.map((u) => u.upstream).sort()).toEqual([...bound].sort());
    expect(data.upstreams.find((u) => u.upstream === "openrouter")).toMatchObject({ kind: "llm" });
    for (const upstream of ["wavespeed", "fal", "sandbase"]) {
      expect(data.upstreams.find((u) => u.upstream === upstream)).toMatchObject({ kind: "reseller" });
    }
    for (const entry of data.upstreams) {
      expect(entry.name).toEqual(expect.any(String));
      expect(entry.name).not.toBe("");
      expect(["llm", "official", "reseller"]).toContain(entry.kind);
      if (entry.keyUrl !== null) expect(entry.keyUrl).toMatch(/^https:\/\//);
    }
    // A language model's own API takes no key here: every language-model call runs on the OpenRouter key.
    expect(data.upstreams.filter((u) => u.kind === "llm").map((u) => u.upstream)).toEqual(["openrouter"]);
  });
});

describe("one account's settings", () => {
  it("are seen and changed by that account alone, whatever id a request sends along", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const aKey = freshKey("fal-");
    expect((await putKey(a.cookie, "fal", aKey)).status).toBe(200);
    expect((await putModel(a.cookie, MODEL, "fal")).status).toBe(200);

    const seen = await app.request(`/api/v1/account/byok?userId=${a.userId}`, { headers: { Cookie: b.cookie } });
    const bView = (await seen.json()) as { data: Settings };
    expect(bView.data.keys).toEqual([]);
    expect(bView.data.models).toEqual([]);

    expect((await call(b.cookie, "DELETE", `/keys/fal?userId=${a.userId}`)).status).toBe(404);
    expect((await call(b.cookie, "POST", "/keys/fal/check")).status).toBe(404);
    expect((await putModel(b.cookie, MODEL, "fal")).status).toBe(422);

    const { data } = await settings(a.cookie);
    expect(data.keys.map((k) => [k.upstream, k.displayHint])).toEqual([["fal", hintOf(aKey)]]);
    expect(data.models).toEqual([{ model: MODEL, upstream: "fal" }]);
  });
});

describe("PUT /api/v1/account/byok/models/:model", () => {
  it("points a media model at an upstream with a live key that runs it, and back at the deployment's keys", async () => {
    const { cookie } = await signedIn();
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);
    expect((await putKey(cookie, "sandbase", freshKey("sb-"))).status).toBe(200);

    expect((await putModel(cookie, MODEL, "fal")).status).toBe(200);
    expect((await settings(cookie)).data.models).toEqual([{ model: MODEL, upstream: "fal" }]);

    expect((await putModel(cookie, MODEL, "sandbase")).status).toBe(200);
    expect((await settings(cookie)).data.models).toEqual([{ model: MODEL, upstream: "sandbase" }]);

    expect((await putModel(cookie, MODEL, null)).status).toBe(200);
    expect((await settings(cookie)).data.models).toEqual([]);
  });

  it("refuses an upstream the account holds no live key for", async () => {
    const { cookie } = await signedIn();
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);
    expect((await call(cookie, "DELETE", "/keys/fal")).ok).toBe(true);

    expect((await putModel(cookie, MODEL, "fal")).status).toBe(422);
    expect((await putModel(cookie, MODEL, "wavespeed")).status).toBe(422);
    expect((await settings(cookie)).data.models).toEqual([]);
  });

  it("refuses an upstream that cannot run the model, though the account holds its key", async () => {
    const { cookie } = await signedIn();
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);

    expect((await putModel(cookie, WAVESPEED_ONLY, "fal")).status).toBe(422);
    expect((await settings(cookie)).data.models).toEqual([]);
  });

  it("lists no choice whose upstream no longer runs the model, as when the configuration drops that binding", async () => {
    const { userId, cookie } = await signedIn();
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);
    // A choice saved while the binding existed: the repository writes it as stored, the way it once passed the route.
    await accountModelUpstreamsRepo.setModelUpstream(userId, WAVESPEED_ONLY, "fal");

    expect((await settings(cookie)).data.models).toEqual([]);
  });

  it("gives a language model no upstream of its own, since every language-model call runs on the OpenRouter key", async () => {
    const { cookie } = await signedIn();
    expect((await putKey(cookie, "openrouter", freshKey())).status).toBe(200);
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);

    expect((await putModel(cookie, LLM_MODEL, "openrouter")).status).toBe(422);
    expect((await putModel(cookie, LLM_MODEL, "fal")).status).toBe(422);
    expect((await putModel(cookie, MODEL, "openrouter")).status).toBe(422);
    expect((await settings(cookie)).data.models).toEqual([]);
  });

  it("refuses a model the catalog does not have", async () => {
    const { cookie } = await signedIn();
    expect((await putKey(cookie, "fal", freshKey("fal-"))).status).toBe(200);

    expect((await putModel(cookie, "no-such-model", "fal")).status).toBe(422);
  });
});

describe("a deployment without master keys", () => {
  it("shows BYOK as off and answers 503 to saving, checking nothing", async () => {
    const { userId, cookie } = await signedIn();
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.PROVIDER_KEY_SECRET_ID;
    delete env.PROVIDER_KEY_SECRETS;
    initCore(env);
    try {
      const { data } = await settings(cookie);
      expect(data.enabled).toBe(false);
      expect((await putKey(cookie, "openrouter", freshKey())).status).toBe(503);
      expect(checkKey).not.toHaveBeenCalled();
      expect(await keyRows(userId)).toEqual([]);
    } finally {
      initCore(BYOK_ENV);
    }
  });
});
