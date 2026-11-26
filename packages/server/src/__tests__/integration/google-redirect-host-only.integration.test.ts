// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Full-page Google sign-in without `COOKIE_DOMAIN` (inner#2157 design §7.9
 * "<回调地址>(站点)"), against real PG + Redis with Google's token endpoint and
 * `verifyIdToken` answered by a double.
 *
 * A self-hosted stack serving one or several exact origins and no parent
 * domain keeps every cookie host-only, so the callback runs on the host the
 * sign-in started from: the second origin's sign-in comes back to the second
 * origin's own callback and signs in there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type * as GoogleAuthLibrary from "google-auth-library";

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

import crypto from "node:crypto";
import postgres from "postgres";
import { env, getRedis, initCore, loadLocales } from "@breatic/core";
import type { Hono } from "hono";
import { withPeer } from "../helpers/peer.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "./google-redirect-harness.js";
import { answerGoogleFrom, begin, bindCookie, callback, cookieLine, redirectOf } from "./google-redirect-steps.js";

const FIRST = "http://localhost:8000";
const SECOND = "http://studio.test:8100";

process.env["COOKIE_DOMAIN"] = "";
process.env["ALLOWED_ORIGINS"] = `${FIRST},${SECOND}`;
process.env["GOOGLE_CLIENT_ID"] = GOOGLE_CLIENT_ID;
process.env["GOOGLE_CLIENT_SECRET"] = GOOGLE_CLIENT_SECRET;
initCore(process.env);
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;
const emails: string[] = [];

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
  answerGoogleFrom(google);
});

beforeEach(() => {
  google.getToken.mockClear();
  google.verifyIdToken.mockClear();
});

afterAll(async () => {
  if (emails.length > 0) await sql`UPDATE users SET deleted_at = now() WHERE email = ANY(${emails}) AND deleted_at IS NULL`;
  await sql?.end({ timeout: 5 });
});

/**
 * A fresh Google account.
 * @returns Its subject and address.
 */
function account(): { sub: string; email: string } {
  const email = `google-host-only-${crypto.randomUUID()}@gmail.com`;
  emails.push(email);
  return { sub: crypto.randomUUID(), email };
}

describe("Google sign-in with COOKIE_DOMAIN empty and two exact origins", () => {
  it.each([
    ["the first origin", FIRST],
    ["the second origin", SECOND],
  ])("puts the callback on %s's own host", async (_name, origin) => {
    const b = await begin(app, { origin });

    expect(b.redirectUri).toBe(`${origin}/api/v1/auth/google/callback`);
  });

  it("signs in from the second origin on its own host with host-only cookies and returns there", async () => {
    const who = account();
    const b = await begin(app, { origin: SECOND }, { page: "login", next: "/studio/home" });
    const bindLine = cookieLine(b.res, bindCookie())!;
    expect(bindLine).not.toMatch(/;\s*Domain=/i);

    const res = await callback(app, b, who);

    const to = redirectOf(res);
    expect(`${to.origin}${to.pathname}`).toBe(`${SECOND}/login`);
    expect(to.searchParams.get("google")).toBe("created");
    expect(to.searchParams.get("next")).toBe("/studio/home");

    const name = `breatic_session_${env.REDIS_KEY_PREFIX}`;
    const session = cookieLine(res, name)!;
    expect(session).toMatch(new RegExp(`^${name}=[^;]+;`));
    expect(session).not.toMatch(/;\s*Domain=/i);
    expect(cookieLine(res, `breatic_site_session_${env.REDIS_KEY_PREFIX}`)).toBeUndefined();

    const me = await app.request(`${SECOND}/api/v1/auth/me`, { headers: { Cookie: session.split(";")[0]! } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { data: { email: string } }).data.email).toBe(who.email);

    const [row] = await sql<{ influencer_code: string }[]>`
      SELECT influencer_code FROM users WHERE email = ${who.email} AND deleted_at IS NULL`;
    expect(row!.influencer_code).toBe("official");
  });

  describe("when the state's site is no longer trusted", () => {
    afterAll(() => {
      initCore(process.env);
    });

    it("returns an expired sign-in to the first origin's login page", async () => {
      const b = await begin(app, { origin: SECOND }, { page: "register" });
      await getRedis().del(...(await getRedis().keys(`*google-login:${b.state.split(".")[0]!}`)));
      initCore({ ...process.env, ALLOWED_ORIGINS: FIRST });

      const res = await callback(app, b, account());

      const to = redirectOf(res);
      expect(`${to.origin}${to.pathname}`).toBe(`${FIRST}/login`);
      expect(to.searchParams.get("googleError")).toBe("expired");
      expect(google.getToken).not.toHaveBeenCalled();
    });
  });
});
