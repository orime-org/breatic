// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `requireAuth` in a region that does not hold the global data (inner#1955):
 * who the user is comes from the identity token cookie, checked with the
 * public keys and this region's revocation tombstones, with no call to the
 * global region and no session read.
 */

import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";

// Filled once the key pair is generated below; the env mock reads it lazily.
const pair = vi.hoisted(() => ({ publicKey: "", privateKey: "" }));

const session = vi.hoisted((): { token: string | null } => ({ token: null }));
vi.mock("@server/middleware/session-cookie.js", () => ({
  readSessionCookie: () => session.token,
}));

const accounts = vi.hoisted(() => ({ getUserByToken: vi.fn() }));
vi.mock("@server/modules", () => ({ authService: accounts }));

const revoked = vi.hoisted(() => ({ isIdentityRevoked: vi.fn<(...args: unknown[]) => Promise<boolean>>() }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getRedis: () => ({}),
    isIdentityRevoked: revoked.isIdentityRevoked,
    identityCookieName: () => "breatic_identity_dev",
    env: new Proxy(
      {},
      {
        get: (_target, key) =>
          ({
            REGION: "sg",
            GLOBAL_REGION: "us-west",
            IDENTITY_PUBLIC_KEYS: { k1: pair.publicKey },
          })[key as string],
      },
    ),
  };
});

import { identityCookieName, loadLocales, signIdentityToken } from "@breatic/core";
import { requireAuth } from "@server/middleware/auth.js";

const keys = generateKeyPairSync("ed25519");
pair.publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
pair.privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

loadLocales();

const USER = "11111111-1111-4111-8111-111111111111";
const SID = "d".repeat(64);

/**
 * A token for {@link USER} signed the given number of seconds ago.
 * @param ageSeconds - How long ago it was signed.
 * @returns The compact token.
 */
function token(ageSeconds: number): string {
  return signIdentityToken(
    { sub: USER, sid: SID, email: "user@example.test", tier: "base", locale: "de", personalStudio: null },
    { kid: "k1", privateKey: pair.privateKey },
    Math.floor(Date.now() / 1000) - ageSeconds,
  );
}

/**
 * A one-route app behind `requireAuth` that echoes the resolved user.
 * @returns The app.
 */
function app(): Hono {
  const hono = new Hono();
  hono.get("/me", requireAuth, (c) => c.json(c.get("user")));
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  session.token = null;
  revoked.isIdentityRevoked.mockResolvedValue(false);
});

describe("requireAuth outside the global region", () => {
  it("resolves the user from a valid identity token without reading a session", async () => {
    const res = await app().request("/me", { headers: { cookie: `${identityCookieName()}=${token(5)}` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: USER,
      email: "user@example.test",
      membershipTier: "base",
      locale: "de",
    });
    expect(accounts.getUserByToken).not.toHaveBeenCalled();
    expect(revoked.isIdentityRevoked).toHaveBeenCalledWith(expect.anything(), SID);
  });

  it("answers 401 when there is no identity cookie, even with a session cookie", async () => {
    session.token = "tok";
    accounts.getUserByToken.mockResolvedValue({ id: USER, email: "x", membershipTier: "base", locale: "en" });

    const res = await app().request("/me", { headers: { cookie: "breatic_session_dev=tok" } });

    expect(res.status).toBe(401);
    expect(accounts.getUserByToken).not.toHaveBeenCalled();
  });

  it("answers 401 identity_expired for an expired token so the page renews and retries", async () => {
    const res = await app().request("/me", { headers: { cookie: `${identityCookieName()}=${token(90)}` } });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { reason?: string } };
    expect(body.error.reason).toBe("identity_expired");
  });

  // After a key rotation a tab that slept may still hold a token signed with
  // a key this region dropped; renewing gives it one signed with the new key.
  it("answers 401 identity_expired for a token signed with a key this region no longer holds", async () => {
    const retired = signIdentityToken(
      { sub: USER, sid: SID, email: "user@example.test", tier: "base", locale: "de", personalStudio: null },
      { kid: "k0", privateKey: pair.privateKey },
      Math.floor(Date.now() / 1000) - 5,
    );

    const res = await app().request("/me", { headers: { cookie: `${identityCookieName()}=${retired}` } });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { reason?: string } };
    expect(body.error.reason).toBe("identity_expired");
  });

  it("answers 401 for a token whose session has a revocation tombstone here", async () => {
    revoked.isIdentityRevoked.mockResolvedValue(true);

    const res = await app().request("/me", { headers: { cookie: `${identityCookieName()}=${token(5)}` } });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { reason?: string } };
    expect(body.error.reason).not.toBe("identity_expired");
  });

  it("answers 401 for a token that does not verify", async () => {
    const [header, payload] = token(5).split(".");
    const res = await app().request("/me", { headers: { cookie: `${identityCookieName()}=${header}.${payload}.AAAA` } });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { reason?: string } };
    expect(body.error.reason).not.toBe("identity_expired");
    expect(revoked.isIdentityRevoked).not.toHaveBeenCalled();
  });
});
