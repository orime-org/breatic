// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Full-page Google sign-in (inner#2157 design §7.9, §8 "谷歌整页跳转") against
 * real PG + Redis, with Google's token endpoint and `verifyIdToken` answered
 * by a double and the real `generateAuthUrl` kept.
 *
 * This suite runs the production shape: `COOKIE_DOMAIN` set (site-wide
 * sign-in), one exact origin in `ALLOWED_ORIGINS` (the official site) and
 * influencer sites registered as `<label>.partner.<COOKIE_DOMAIN>`. Every
 * begin goes to Google with the official callback; the callback returns the
 * browser to the site and page the sign-in started from.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type * as BreaticCore from "@breatic/core";
import type * as GoogleAuthLibrary from "google-auth-library";
import type * as RateLimits from "@server/config/rate-limits.js";

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

const google = vi.hoisted(() => ({ getToken: vi.fn(), verifyIdToken: vi.fn() }));
vi.mock("google-auth-library", async (io) => {
  const { googleClientDouble } = await import("./google-redirect-harness.js");
  return googleClientDouble(await io<typeof GoogleAuthLibrary>(), google);
});

// The limiter's Redis call (`eval`) can be made to fail; every other command goes through.
const redisFault = vi.hoisted((): { limiterRejects: boolean } => ({ limiterRejects: false }));
vi.mock("@breatic/core", async (io) => {
  const actual = await io<typeof BreaticCore>();
  /**
   * Wrap the real client so the limiter's call can fail on demand.
   * @param real - The real ioredis client.
   * @returns The wrapped client.
   */
  function faulty(real: ReturnType<typeof actual.getRedis>): ReturnType<typeof actual.getRedis> {
    return new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (redisFault.limiterRejects && prop === "eval") {
          return async () => {
            throw new Error("Connection is closed.");
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }
  return { ...actual, getRedis: () => faulty(actual.getRedis()) };
});

// Two begins per address and window, so the third is refused without 150 requests.
vi.mock("@server/config/rate-limits.js", async (io) => {
  const actual = await io<typeof RateLimits>();
  return {
    ...actual,
    getRateLimit: (action: string) => (action === "google" ? { max: 2, windowSeconds: 300 } : actual.getRateLimit(action)),
  };
});

import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { env, getRedis, initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";
import { PROXY_PEER, withPeer } from "../helpers/peer.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "./google-redirect-harness.js";
import {
  answerGoogleFrom,
  begin,
  begun,
  callback,
  cookieLine,
  postBegin,
  redirectOf,
  s256,
  signInWithGoogle,
  type Begun,
} from "./google-redirect-steps.js";

const OFFICIAL = "http://localhost:8000";
const OFFICIAL_CALLBACK = `${OFFICIAL}/api/v1/auth/google/callback`;
const suffix = crypto.randomUUID().slice(0, 8);
const ALICE_CODE = `gr-alice-${suffix}`;
const ALICE = `http://${ALICE_CODE}.partner.localhost:8000`;
const PAUSED_CODE = `gr-paused-${suffix}`;
const PAUSED = `http://${PAUSED_CODE}.partner.localhost:8000`;
const STRANGER = `http://gr-stranger-${suffix}.partner.localhost:8000`;

process.env["COOKIE_DOMAIN"] = "localhost";
process.env["GOOGLE_CLIENT_ID"] = GOOGLE_CLIENT_ID;
process.env["GOOGLE_CLIENT_SECRET"] = GOOGLE_CLIENT_SECRET;
initCore(process.env);
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
let proxied: Hono;
const emails: string[] = [];

/** The site-wide session cookie's name while `COOKIE_DOMAIN` is set (design §7.9 "全站会话"). */
const siteSession = (): string => `breatic_site_session_${env.REDIS_KEY_PREFIX}`;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  // Registered before the app answers anything, so the trusted-host cache starts with them.
  await sql`INSERT INTO influencers (code, host) VALUES (${ALICE_CODE}, ${`${ALICE_CODE}.partner.localhost`})`;
  await sql`INSERT INTO influencers (code, host, disabled_at) VALUES (${PAUSED_CODE}, ${`${PAUSED_CODE}.partner.localhost`}, now())`;
  const { createApp } = await import("@server/app.js");
  const created = createApp();
  app = withPeer(created);
  proxied = withPeer(created, PROXY_PEER);
  answerGoogleFrom(google);
});

beforeEach(() => {
  google.getToken.mockClear();
  google.verifyIdToken.mockClear();
});

afterEach(() => {
  redisFault.limiterRejects = false;
});

afterAll(async () => {
  if (emails.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE email = ANY(${emails}) AND deleted_at IS NULL`;
  await sql?.end({ timeout: 5 });
});

/**
 * A fresh Google account.
 * @param domain - The address's domain.
 * @returns Its subject and address.
 */
function account(domain = "gmail.com"): { sub: string; email: string } {
  const email = `google-redirect-${crypto.randomUUID()}@${domain}`;
  emails.push(email);
  return { sub: crypto.randomUUID(), email };
}

/** The columns a sign-up writes. */
interface UserRow {
  id: string;
  influencer_code: string;
  locale: string;
  email_verified: boolean;
  google_id: string | null;
}

/**
 * The live account with this address.
 * @param email - The address.
 * @returns Its row, or undefined.
 */
async function userOf(email: string): Promise<UserRow | undefined> {
  const [row] = await sql<UserRow[]>`
    SELECT id, influencer_code, locale, email_verified, google_id FROM users WHERE email = ${email} AND deleted_at IS NULL`;
  return row;
}

/**
 * Check where a 303 sends the browser.
 * @param res - The response.
 * @param site - The site and page path it must land on.
 * @param params - Query parameters it must carry.
 */
function expectBackTo(res: Response, site: string, params: Record<string, string>): void {
  const to = redirectOf(res);
  expect(`${to.origin}${to.pathname}`).toBe(site);
  for (const [name, value] of Object.entries(params)) expect(to.searchParams.get(name)).toBe(value);
}

/**
 * A random client address our proxy would write.
 * @returns The address.
 */
function freshIp(): string {
  const b = crypto.randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

describe("POST /api/v1/auth/google/begin", () => {
  it("answers a begin from an Origin that is neither listed nor registered with 403 and sets no bind cookie", async () => {
    const res = await postBegin(app, { origin: STRANGER });

    expect(res.status).toBe(403);
    expect(cookieLine(res, "breatic_google_bind")).toBeUndefined();
  });

  it("answers a begin without an Origin with 403", async () => {
    const res = await postBegin(app, {});

    expect(res.status).toBe(403);
    expect(cookieLine(res, "breatic_google_bind")).toBeUndefined();
  });

  it("sends an influencer site's browser to Google with the official callback, S256 PKCE, a nonce and select_account", async () => {
    const b = await begin(app, { origin: ALICE });

    expect(`${b.toGoogle.origin}${b.toGoogle.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(b.toGoogle.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(b.redirectUri).toBe(OFFICIAL_CALLBACK);
    expect(b.toGoogle.searchParams.get("response_type")).toBe("code");
    expect(b.toGoogle.searchParams.get("scope")!.split(" ").sort()).toEqual(["email", "openid", "profile"]);
    expect(b.toGoogle.searchParams.get("code_challenge_method")).toBe("S256");
    expect(b.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.nonce.length).toBeGreaterThanOrEqual(32);
    expect(b.toGoogle.searchParams.get("prompt")).toBe("select_account");
    expect(b.state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("sets the bind cookie HttpOnly, Lax, for the state's lifetime, on COOKIE_DOMAIN", async () => {
    const b = await begin(app, { origin: ALICE });
    const line = cookieLine(b.res, "breatic_google_bind")!;

    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Max-Age=600(;|$)/i);
    expect(line).toMatch(/;\s*Domain=localhost(;|$)/i);
  });

  it("keeps the sign-in's state in Redis under its random part for state_ttl_seconds (600)", async () => {
    const b = await begin(app, { origin: ALICE });
    const random = b.state.split(".")[0]!;
    const keys = await getRedis().keys(`*google-login:${random}`);

    expect(keys).toHaveLength(1);
    const ttl = await getRedis().ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("answers the begin over the address's limit with a 303 back to the page carrying rate_limited and next", async () => {
    const ip = freshIp();
    const fields = { page: "login" as const, next: "/studio/limit" };
    begun(await postBegin(proxied, { origin: ALICE, realIp: ip }, fields));
    begun(await postBegin(proxied, { origin: ALICE, realIp: ip }, fields));

    const third = await postBegin(proxied, { origin: ALICE, realIp: ip }, fields);

    expectBackTo(third, `${ALICE}/login`, { googleError: "rate_limited", next: "/studio/limit" });
    expect(cookieLine(third, "breatic_google_bind")).toBeUndefined();
  });

  it("answers a begin whose limiter cannot reach Redis with a 303 back to the page carrying unavailable and next", async () => {
    redisFault.limiterRejects = true;

    const res = await postBegin(proxied, { origin: ALICE, realIp: freshIp() }, { page: "register", next: "/studio/down" });

    expectBackTo(res, `${ALICE}/register`, { googleError: "unavailable", next: "/studio/down" });
    expect(cookieLine(res, "breatic_google_bind")).toBeUndefined();
  });

  describe("with API_PUBLIC_URL set (front end and API on separate hosts)", () => {
    beforeAll(() => {
      initCore({ ...process.env, API_PUBLIC_URL: "http://api.localhost:3000/api/v1" });
    });
    afterAll(() => {
      initCore(process.env);
    });

    it("puts the callback under API_PUBLIC_URL and signs in there", async () => {
      const b = await begin(app, { origin: ALICE });
      expect(b.redirectUri).toBe("http://api.localhost:3000/api/v1/auth/google/callback");

      const res = await callback(app, b, account());

      expectBackTo(res, `${ALICE}/register`, { google: "created", next: "/studio" });
    });
  });

  describe("without GOOGLE_CLIENT_SECRET", () => {
    beforeAll(() => {
      initCore({ ...process.env, GOOGLE_CLIENT_SECRET: "" });
    });
    afterAll(() => {
      initCore(process.env);
    });

    it("answers begin with a 303 back to the page carrying unavailable", async () => {
      const res = await postBegin(app, { origin: ALICE }, { page: "login" });

      expectBackTo(res, `${ALICE}/login`, { googleError: "unavailable" });
      expect(cookieLine(res, "breatic_google_bind")).toBeUndefined();
    });
  });
});

describe("GET /api/v1/auth/options googleSignIn", () => {
  afterAll(() => {
    initCore(process.env);
  });

  it.each([
    [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, true],
    [GOOGLE_CLIENT_ID, "", false],
    ["", GOOGLE_CLIENT_SECRET, false],
    ["", "", false],
  ])("client id %j and secret %j → googleSignIn %s", async (id, secret, shown) => {
    initCore({ ...process.env, GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret });

    const res = await app.request("/api/v1/auth/options");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { googleSignIn: unknown } }).data.googleSignIn).toBe(shown);
  });
});

describe("GET /api/v1/auth/google/callback", () => {
  it("signs a new account up under the begin Origin's influencer, sets the site-wide session and returns to the starting page", async () => {
    const who = account();
    const b = await begin(app, { origin: ALICE }, { page: "register", next: "/studio/welcome" });

    const res = await callback(app, b, who);

    expectBackTo(res, `${ALICE}/register`, { google: "created", next: "/studio/welcome" });
    const session = cookieLine(res, siteSession())!;
    expect(session).toMatch(new RegExp(`^${siteSession()}=[^;]+;`));
    expect(session).toMatch(/;\s*Domain=localhost(;|$)/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(cookieLine(res, "breatic_google_bind")).toMatch(/^breatic_google_bind=;.*Max-Age=0/i);

    const row = (await userOf(who.email))!;
    expect(row.influencer_code).toBe(ALICE_CODE);
    expect(row.google_id).toBe(who.sub);

    const me = await app.request(`${ALICE}/api/v1/auth/me`, { headers: { Cookie: session.split(";")[0]! } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { data: { id: string; email: string } }).data).toMatchObject({ id: row.id, email: who.email });
  });

  it("exchanges the code with the begin's PKCE verifier and checks the ID token's audience", async () => {
    const b = await begin(app, { origin: ALICE });

    await callback(app, b, account());

    expect(google.getToken).toHaveBeenCalledTimes(1);
    const exchange = google.getToken.mock.calls[0]![0] as { code: string; codeVerifier: string };
    expect(exchange.code).toMatch(/^code-/);
    expect(s256(exchange.codeVerifier)).toBe(b.codeChallenge);
    expect(google.verifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: `id-token:${exchange.code}`, audience: GOOGLE_CLIENT_ID }),
    );
  });

  it("records the official code for a sign-up from the official site", async () => {
    const who = account();

    const { res } = await signInWithGoogle(app, { origin: OFFICIAL }, who);

    expectBackTo(res, `${OFFICIAL}/register`, { google: "created" });
    expect((await userOf(who.email))!.influencer_code).toBe("official");
  });

  it("records the official code for a sign-up from a disabled influencer's site, whose begin is still allowed", async () => {
    const who = account();

    const { res } = await signInWithGoogle(app, { origin: PAUSED }, who);

    expectBackTo(res, `${PAUSED}/register`, { google: "created" });
    expect((await userOf(who.email))!.influencer_code).toBe("official");
  });

  it("keeps an existing account's code when it signs in with Google from an influencer site", async () => {
    const who = account();
    await signInWithGoogle(app, { origin: OFFICIAL }, who);

    const { res } = await signInWithGoogle(app, { origin: ALICE }, who, { page: "login", next: "/studio/again" });

    expectBackTo(res, `${ALICE}/login`, { google: "signed_in", next: "/studio/again" });
    expect((await userOf(who.email))!.influencer_code).toBe("official");
  });

  it("gives a new account the begin form's locale, not the callback's or the begin's Accept-Language", async () => {
    const who = account();

    await signInWithGoogle(app, { origin: ALICE, acceptLanguage: "ja" }, who, { locale: "ko" }, { acceptLanguage: "ja" });

    expect((await userOf(who.email))!.locale).toBe("ko");
  });

  it("falls back to the begin request's negotiated language when the form's locale is not supported", async () => {
    const who = account();

    await signInWithGoogle(app, { origin: ALICE, acceptLanguage: "ja" }, who, { locale: "xx-YY" }, { acceptLanguage: "ko" });

    expect((await userOf(who.email))!.locale).toBe("ja");
  });

  it("uses a state once: the replayed callback returns expired, sets no session and does not ask Google again", async () => {
    const who = account();
    const b = await begin(app, { origin: ALICE }, { page: "login" });
    expectBackTo(await callback(app, b, who), `${ALICE}/login`, { google: "created" });

    const replay = await callback(app, b, who);

    expectBackTo(replay, `${ALICE}/login`, { googleError: "expired" });
    expect(cookieLine(replay, siteSession())).toBeUndefined();
    expect(google.getToken).toHaveBeenCalledTimes(1);
  });

  it("treats a state gone from Redis as expired and returns to the site and page the state names", async () => {
    const who = account();
    const b = await begin(app, { origin: ALICE }, { page: "register" });
    await getRedis().del(...(await getRedis().keys(`*google-login:${b.state.split(".")[0]!}`)));

    const res = await callback(app, b, who);

    expectBackTo(res, `${ALICE}/register`, { googleError: "expired" });
    expect(cookieLine(res, siteSession())).toBeUndefined();
    expect(google.getToken).not.toHaveBeenCalled();
    expect(await userOf(who.email)).toBeUndefined();
  });

  it("returns to the official login page when the state cannot be split", async () => {
    const b = await begin(app, { origin: ALICE });

    const res = await callback(app, b, account(), { state: "not-a-state" });

    expectBackTo(res, `${OFFICIAL}/login`, { googleError: "expired" });
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it("refuses a callback that brings no bind cookie as expired, without asking Google or setting a session", async () => {
    const who = account();
    const b = await begin(app, { origin: ALICE });

    const res = await callback(app, b, who, { bind: "" });

    expectBackTo(res, `${ALICE}/register`, { googleError: "expired" });
    expect(cookieLine(res, siteSession())).toBeUndefined();
    expect(google.getToken).not.toHaveBeenCalled();
    expect(await userOf(who.email)).toBeUndefined();
  });

  it("refuses a callback whose bind cookie came from another begin (someone else's link) as expired", async () => {
    const who = account();
    const victims = await begin(app, { origin: ALICE });
    const attackers = await begin(app, { origin: ALICE });

    const res = await callback(app, attackers, who, { bind: victims.bind });

    expectBackTo(res, `${ALICE}/register`, { googleError: "expired" });
    expect(cookieLine(res, siteSession())).toBeUndefined();
    expect(google.getToken).not.toHaveBeenCalled();
    expect(await userOf(who.email)).toBeUndefined();
  });

  it("returns cancelled with next when Google answers with an error, without exchanging a code", async () => {
    const b = await begin(app, { origin: ALICE }, { page: "login", next: "/studio/cancel" });

    const res = await callback(app, b, account(), { error: "access_denied" });

    expectBackTo(res, `${ALICE}/login`, { googleError: "cancelled", next: "/studio/cancel" });
    expect(cookieLine(res, siteSession())).toBeUndefined();
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it("refuses an ID token whose nonce is not the begin's as invalid_credential and creates no account", async () => {
    const who = account();
    const b = await begin(app, { origin: ALICE }, { next: "/studio/nonce" });

    const res = await callback(app, b, { ...who, nonce: "some-other-nonce" });

    expectBackTo(res, `${ALICE}/register`, { googleError: "invalid_credential", next: "/studio/nonce" });
    expect(cookieLine(res, siteSession())).toBeUndefined();
    expect(await userOf(who.email)).toBeUndefined();
  });

  it.each([
    ["a token Google's check rejects", { reject: true }, "invalid_credential"],
    ["a token from another issuer", { iss: "https://evil.example" }, "invalid_credential"],
    ["an address Google has not verified", { emailVerified: false }, "email_unverified"],
  ])("refuses %s, returning %s with next and creating no account", async (_name, answer, reason) => {
    const who = account();
    const b = await begin(app, { origin: ALICE }, { next: "/studio/bad" });

    const res = await callback(app, b, { ...who, ...answer });

    expectBackTo(res, `${ALICE}/register`, { googleError: reason, next: "/studio/bad" });
    expect(cookieLine(res, siteSession())).toBeUndefined();
    expect(await userOf(who.email)).toBeUndefined();
  });

  it.each([
    ["a Gmail address", "gmail.com", undefined, true],
    ["a Workspace address", "company.example", "company.example", true],
    ["an address Google does not own", "third-party.example", undefined, false],
  ])("marks %s verified only when Google owns it", async (_name, domain, hd, verified) => {
    const who = account(domain);

    const { res } = await signInWithGoogle(app, { origin: ALICE }, { ...who, ...(hd ? { hd } : {}) });

    expectBackTo(res, `${ALICE}/register`, { google: "created" });
    expect((await userOf(who.email))!.email_verified).toBe(verified);
  });

  it("normalises the token's address before storing it and judging Gmail ownership", async () => {
    const who = account();

    await signInWithGoogle(app, { origin: ALICE }, { sub: who.sub, email: ` ${who.email.toUpperCase()}` });

    const row = (await userOf(who.email))!;
    expect(row.google_id).toBe(who.sub);
    expect(row.email_verified).toBe(true);
  });

  it("answers link_requires_email_login with next when the address is an email account Google cannot vouch for", async () => {
    const email = `google-redirect-${crypto.randomUUID()}@example.test`;
    emails.push(email);
    const reg = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery" }),
    });
    expect(reg.status).toBe(201);

    const { res } = await signInWithGoogle(app, { origin: ALICE }, { sub: crypto.randomUUID(), email }, { page: "login", next: "/studio/link" });

    expectBackTo(res, `${ALICE}/login`, { googleError: "link_requires_email_login", next: "/studio/link" });
    expect(cookieLine(res, siteSession())).toBeUndefined();
    expect((await userOf(email))!.google_id).toBeNull();
  });
});

describe("begin and callback in any order (fast-check)", () => {
  /** One request one of two browsers makes. */
  type Step = { kind: "begin"; browser: 0 | 1 } | { kind: "callback"; attempt: number; browser: 0 | 1 };

  const browser = fc.constantFrom<0 | 1>(0, 1);
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ kind: fc.constant<"begin">("begin"), browser }),
    fc.record({ kind: fc.constant<"callback">("callback"), attempt: fc.nat(7), browser }),
  );

  /**
   * Apply a response's cookies to a browser's jar the way a browser does.
   * @param jar - Cookie values by name.
   * @param res - The response.
   */
  function store(jar: Map<string, string>, res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at);
      const value = pair!.slice(at + 1);
      if (value === "" || /;\s*Max-Age=0(;|$)/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  it("sets a session only for the first callback of a state, in the browser whose bind that begin set", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
        const who = account();
        const jars = [new Map<string, string>(), new Map<string, string>()];
        const attempts: { b: Begun; used: boolean }[] = [];
        let sessions = 0;
        google.getToken.mockClear();

        for (const s of steps) {
          if (s.kind === "begin") {
            const b = await begin(app, { origin: ALICE }, { page: "login" });
            store(jars[s.browser]!, b.res);
            attempts.push({ b, used: false });
            continue;
          }
          if (attempts.length === 0) continue;
          const attempt = attempts[s.attempt % attempts.length]!;
          const jar = jars[s.browser]!;
          const held = jar.get("breatic_google_bind");
          const bind = held === undefined ? "" : `breatic_google_bind=${held}`;
          const expected = !attempt.used && bind === attempt.b.bind;

          const res = await callback(app, attempt.b, who, { bind });
          attempt.used = true;
          store(jar, res);

          const to = redirectOf(res);
          expect(`${to.origin}${to.pathname}`).toBe(`${ALICE}/login`);
          expect(cookieLine(res, siteSession()) !== undefined).toBe(expected);
          if (expected) {
            sessions += 1;
            expect(["created", "signed_in"]).toContain(to.searchParams.get("google"));
          } else {
            expect(to.searchParams.get("google")).toBeNull();
            expect(to.searchParams.get("googleError")).toBe("expired");
          }
        }
        expect(google.getToken).toHaveBeenCalledTimes(sessions);
      }),
      { numRuns: 15 },
    );
  });
});
