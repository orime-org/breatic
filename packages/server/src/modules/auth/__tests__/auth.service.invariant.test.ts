// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * auth.service invariant tests — lock current behavior (PR-a task 1).
 *
 * These tests assert behavior that already exists today (per `grep`-based
 * spec amend 2026-05-26). They should pass on current `main` as-is and
 * stay green after PR-a dev-bypass auth deletion + recovery code addition.
 *
 * Locked invariants:
 *
 *   1. BCRYPT_ROUNDS = 12 — register() and resetPassword() hash with cost 12
 *      (verified via bcrypt hash prefix $2[abxy]$12$). Defends against
 *      future "let's lower cost for speed" regressions.
 *
 *   2. forgotPassword anti-enumeration — when getUserByEmail returns null,
 *      the function returns silently (no throw, no sendMail call). Defends
 *      against future "let's tell the user their email isn't registered"
 *      regression that would leak account presence.
 *
 *   3. forgotPassword on existing email — Redis SETEX with TTL 3600s
 *      (RESET_TOKEN_TTL = 3600), key prefix `${env.ENV}:password-reset:`,
 *      sendMail called once. Defends against TTL drift / key-prefix change.
 *
 *   4. resetPassword token contract — expired (null Redis GET) throws;
 *      valid token causes (a) password updated with cost-12 bcrypt,
 *      (b) Redis key deleted (no replay), (c) deleteAllSessions called
 *      (force re-login after reset). Defends against partial cleanup
 *      regressions.

 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

// Redis + session funcs + env all resolve from the @breatic/core barrel
// now (post core-convergence): auth.service reads getRedis() / setSession
// / deleteAllSessions / env.ENV from it. Mock the barrel — importOriginal
// keeps the real ConflictError / UnauthorizedError classes for the throw
// assertions.
const mockRedis = {
  set: vi.fn().mockResolvedValue("OK"),
  get: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
};
const mockDeleteAllSessions = vi.fn();
vi.mock("@breatic/core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendMail: mockSendMail,
    getRedis: () => mockRedis,
    setSession: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteAllSessions: mockDeleteAllSessions,
    env: { ENV: "test" },
  };
});

// Mocked EXPLICITLY (no importOriginal) so loading @breatic/domain never
// pulls the real agent llm and the `ai` SDK behind it.
vi.mock("@breatic/domain", () => ({
}));

const mockSendMail = vi.fn().mockResolvedValue(true);

const mockGetUserByEmail = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdatePassword = vi.fn();
const mockSetRecoveryCode = vi.fn().mockResolvedValue(undefined);
vi.mock("@server/modules/auth/user.repo.js", () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: vi.fn(),
  getUserByGoogleId: vi.fn(),
  createUser: mockCreateUser,
  updateUser: vi.fn(),
  linkGoogleIdentity: vi.fn(),
  getHashedPassword: vi.fn(),
  updatePassword: mockUpdatePassword,
  setRecoveryCode: mockSetRecoveryCode,
  getRecoveryCode: vi.fn(),
  markRecoveryCodeUsed: vi.fn(),
}));

// register no longer creates a personal studio (that is the explicit
// setup-studio step). The studio.service mock is still declared so a
// regression that re-introduces an eager studio call surfaces (the spy
// must stay un-called).
const mockCreatePersonalStudio = vi.fn();
vi.mock("@server/modules/studio/studio.service.js", () => ({
  createPersonalStudio: mockCreatePersonalStudio,
  getPersonalStudio: vi.fn(),
  getPersonalStudioIdentitiesByUserIds: vi.fn(),
}));

vi.mock("@breatic/shared", async (importOriginal: () => Promise<Record<string, unknown>>) => ({
  ...(await importOriginal()),
  t: (k: string) => k,
}));

describe("auth.service invariant — BCRYPT_ROUNDS = 12 (锁现状回归)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("register() produces bcrypt hash with cost-12 prefix", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    let capturedHash: string | undefined;
    mockCreateUser.mockImplementation(async (data: { hashedPassword?: string; email: string }) => {
      capturedHash = data.hashedPassword;
      return { id: "u-new", email: data.email };
    });

    const { register } = await import("../auth.service.js");
    await register("new@example.com", "validPassword123");

    expect(capturedHash).toBeDefined();
    expect(capturedHash).toMatch(/^\$2[abxy]\$12\$/);
  });

  it("register() takes ONLY email + password — no display name (it moved to the personal studio)", async () => {
    // Email-registration rewrite (2026-06-06): `users` is a pure auth
    // table. The display name + URL handle live on the personal studio,
    // created in the explicit second step (setup-studio). createUser must
    // be called with email + hashedPassword only — never a `username`. A
    // regression that re-adds the name arg trips this assertion.
    mockGetUserByEmail.mockResolvedValue(null);
    let captured: Record<string, unknown> | undefined;
    mockCreateUser.mockImplementation(async (data: Record<string, unknown>) => {
      captured = data;
      return { id: "u-new", email: data.email };
    });

    const { register } = await import("../auth.service.js");
    await register("noname@example.com", "validPassword123");

    expect(captured).toBeDefined();
    expect(Object.keys(captured!).sort()).toEqual(["email", "hashedPassword"]);
    expect(captured).not.toHaveProperty("username");
  });

  it("register() does NOT create a personal studio — that is the explicit setup-studio step", async () => {
    // Onboarding step 1 creates only the account; the personal studio is
    // created later when the user picks a slug. A regression that eagerly
    // creates a studio at register time trips this (the spy must stay
    // un-called).
    mockGetUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: "u-new",
      email: "new@example.com",
    });

    const { register } = await import("../auth.service.js");
    await register("new@example.com", "validPassword123");

    expect(mockCreatePersonalStudio).not.toHaveBeenCalled();
  });

  it("register() returns recoveryCode (XXXX-XXXX-XXXX-XXXX) + setRecoveryCode stores cost-12 bcrypt hash", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: "u-new",
      email: "new@example.com",
    });

    const { register } = await import("../auth.service.js");
    const result = await register("new@example.com", "validPassword123");

    // Returned recovery code is plaintext, base32 XXXX-XXXX-XXXX-XXXX
    expect(result.user.id).toBe("u-new");
    expect(result.recoveryCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);

    // setRecoveryCode called once, with bcrypt-cost-12 hash (never the plaintext)
    expect(mockSetRecoveryCode).toHaveBeenCalledOnce();
    const [userId, storedHash] = mockSetRecoveryCode.mock.calls[0] as [string, string];
    expect(userId).toBe("u-new");
    expect(storedHash).toMatch(/^\$2[abxy]\$12\$/);
    expect(storedHash).not.toBe(result.recoveryCode);
  });

  it("resetPassword() also hashes with cost 12", async () => {
    mockRedis.get.mockResolvedValue("u-1");
    let capturedHash: string | undefined;
    mockUpdatePassword.mockImplementation(async (_userId: string, hashed: string) => {
      capturedHash = hashed;
    });

    const { resetPassword } = await import("../auth.service.js");
    await resetPassword("valid-token", "newPassword123");

    expect(capturedHash).toBeDefined();
    expect(capturedHash).toMatch(/^\$2[abxy]\$12\$/);
  });
});

describe("auth.service invariant — forgotPassword anti-enumeration (锁现状回归)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("when email not registered: returns { status: 'unknown_email' } — no throw, no sendMail, no Redis SET (anti-enumeration via discriminated result, caller still echoes generic response)", async () => {
    mockGetUserByEmail.mockResolvedValue(null);

    const { forgotPassword } = await import("../auth.service.js");
    await expect(
      forgotPassword("unknown@nowhere.com", "https://app.example/reset"),
    ).resolves.toEqual({ status: "unknown_email" });

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("when email registered: Redis SETEX `test:password-reset:{token}` with TTL 3600s + sendMail called once", async () => {
    mockGetUserByEmail.mockResolvedValue({
      id: "u-1",
      email: "real@example.com",
    });

    const { forgotPassword } = await import("../auth.service.js");
    await forgotPassword("real@example.com", "https://app.example/reset");

    expect(mockRedis.set).toHaveBeenCalledOnce();
    const [key, value, mode, ttl] = mockRedis.set.mock.calls[0] as [string, string, string, number];
    expect(key).toMatch(/^test:password-reset:[0-9a-f]{64}$/);
    expect(value).toBe("u-1");
    expect(mode).toBe("EX");
    expect(ttl).toBe(3600);
    expect(mockSendMail).toHaveBeenCalledOnce();
  });
});

describe("auth.service invariant — resetPassword token contract (锁现状回归)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when Redis returns null (token expired / never existed / already used)", async () => {
    mockRedis.get.mockResolvedValue(null);

    const { resetPassword } = await import("../auth.service.js");
    await expect(
      resetPassword("expired-or-invalid-token", "newPassword123"),
    ).rejects.toThrow();

    expect(mockUpdatePassword).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockDeleteAllSessions).not.toHaveBeenCalled();
  });

  it("on success: updatePassword + Redis DEL + deleteAllSessions all called (atomic semantics — no partial cleanup)", async () => {
    mockRedis.get.mockResolvedValue("u-1");

    const { resetPassword } = await import("../auth.service.js");
    await resetPassword("valid-token", "newPassword123");

    expect(mockUpdatePassword).toHaveBeenCalledOnce();
    expect(mockRedis.del).toHaveBeenCalledOnce();
    const delKey = mockRedis.del.mock.calls[0]?.[0] as string;
    expect(delKey).toMatch(/^test:password-reset:valid-token$/);
    expect(mockDeleteAllSessions).toHaveBeenCalledOnce();
  });
});

describe("auth.service invariant — Google OAuth is pure auth (#1808, INV-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loginOrCreateGoogle never imports Google profile fields — never imports Google name/avatar, only syncs email_verified", async () => {
    // #1808: Google is pure authentication. Identity is user-owned (the slug
    // picked at slug-setup + a UI avatar upload, #1809), so Google's display
    // name / picture are never accepted here. A regression that re-adds a
    // name/avatar param or writes an avatar (`users.avatar_url` is gone) trips
    // this: updateUser must be called with { emailVerified: true } ONLY.
    const existing = {
      id: "u-g",
      email: "g@x.com",
      emailVerified: true,
      googleId: "g-1",
      membershipTier: "base" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const userRepo = await import("@server/modules/auth/user.repo.js");
    vi.mocked(userRepo.getUserByGoogleId).mockResolvedValue(existing);
    let capturedUpdate: Record<string, unknown> | undefined;
    vi.mocked(userRepo.updateUser).mockImplementation(async (_id, data) => {
      capturedUpdate = data;
      return existing;
    });

    const { loginOrCreateGoogle } = await import("../auth.service.js");
    // Only verified identity and email authority enter the service.
    await loginOrCreateGoogle("g-1", "g@x.com", true);

    expect(capturedUpdate).toEqual({ emailVerified: true });
    expect(Object.keys(capturedUpdate!)).toEqual(["emailVerified"]);
    // No personal studio is created in the OAuth path (slug-setup handles it).
    expect(mockCreatePersonalStudio).not.toHaveBeenCalled();
  });
});

// Google must never claim an existing account using an email it does not own.
describe('Google account binding', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const repo = await import('../user.repo.js');
    vi.mocked(repo.getUserByGoogleId).mockResolvedValue(null);
  });

  it('rejects automatic linking for a third-party email', async () => {
    const repo = await import('../user.repo.js');
    const core = await import('@breatic/core');
    vi.mocked(repo.getUserByEmail).mockResolvedValue({ id: 'victim', email: 'owner@example.com', googleId: null } as never);
    const { loginOrCreateGoogle } = await import('../auth.service.js');
    await expect(loginOrCreateGoogle('new-google', 'owner@example.com', false)).rejects.toThrow();
    expect(repo.updateUser).not.toHaveBeenCalled();
    expect(core.setSession).not.toHaveBeenCalled();
  });

  it('never replaces a different linked Google identity', async () => {
    const repo = await import('../user.repo.js');
    const core = await import('@breatic/core');
    vi.mocked(repo.getUserByEmail).mockResolvedValue({ id: 'victim', email: 'owner@gmail.com', googleId: 'old-google' } as never);
    const { loginOrCreateGoogle } = await import('../auth.service.js');
    await expect(loginOrCreateGoogle('new-google', 'owner@gmail.com', true)).rejects.toThrow();
    expect(repo.updateUser).not.toHaveBeenCalled();
    expect(core.setSession).not.toHaveBeenCalled();
  });

  it('does not mark an old address verified when the linked Google email changes', async () => {
    const repo = await import('../user.repo.js');
    vi.mocked(repo.getUserByGoogleId).mockResolvedValue({ id: 'bound', email: 'old@example.com', googleId: 'google-1', emailVerified: false } as never);
    const { loginOrCreateGoogle } = await import('../auth.service.js');
    await loginOrCreateGoogle('google-1', 'new@gmail.com', true);
    expect(repo.updateUser).not.toHaveBeenCalled();
  });
});


describe('Google identity session success boundaries', () => {
  beforeEach(() => vi.resetAllMocks());

  it('links a Google-authoritative email and issues a session', async () => {
    const repo = await import('../user.repo.js');
    const core = await import('@breatic/core');
    const user = { id: 'existing', email: 'owner@gmail.com', googleId: null };
    vi.mocked(repo.getUserByGoogleId).mockResolvedValue(null);
    vi.mocked(repo.getUserByEmail).mockResolvedValue(user as never);
    vi.mocked(repo.linkGoogleIdentity).mockResolvedValue({ ...user, googleId: 'subject' } as never);
    vi.mocked(repo.updateUser).mockResolvedValue({ ...user, googleId: 'subject', emailVerified: true } as never);
    const { loginOrCreateGoogle } = await import('../auth.service.js');
    const result = await loginOrCreateGoogle('subject', user.email, true);
    expect(repo.linkGoogleIdentity).toHaveBeenCalledWith('existing', 'subject');
    expect(core.setSession).toHaveBeenCalledWith(mockRedis, result.token, 'existing');
    expect(result.user.emailVerified).toBe(true);
  });

  it('does not issue a session if concurrent linking wins', async () => {
    const repo = await import('../user.repo.js');
    const core = await import('@breatic/core');
    vi.mocked(repo.getUserByGoogleId).mockResolvedValue(null);
    vi.mocked(repo.getUserByEmail).mockResolvedValue({ id: 'existing', email: 'owner@gmail.com', googleId: null } as never);
    vi.mocked(repo.linkGoogleIdentity).mockResolvedValue(null);
    const { loginOrCreateGoogle } = await import('../auth.service.js');
    await expect(loginOrCreateGoogle('subject', 'owner@gmail.com', true)).rejects.toThrow();
    expect(core.setSession).not.toHaveBeenCalled();
  });

  it('creates an unverified third-party-email account without claiming an existing user', async () => {
    const repo = await import('../user.repo.js');
    vi.mocked(repo.getUserByGoogleId).mockResolvedValue(null);
    vi.mocked(repo.getUserByEmail).mockResolvedValue(null);
    vi.mocked(repo.createUser).mockResolvedValue({ id: 'new', email: 'new@example.com', googleId: 'subject', emailVerified: false } as never);
    const { loginOrCreateGoogle } = await import('../auth.service.js');
    const result = await loginOrCreateGoogle('subject', 'new@example.com', false);
    expect(repo.createUser).toHaveBeenCalledWith({ email: 'new@example.com', googleId: 'subject' });
    expect(repo.updateUser).not.toHaveBeenCalled();
    expect(result.user.emailVerified).toBe(false);
  });
});


it('never issues a session for any conflicting Google subject', async () => {
  const repo = await import('./../user.repo.js');
  const core = await import('@breatic/core');
  const { loginOrCreateGoogle } = await import('../auth.service.js');
  await fc.assert(fc.asyncProperty(
    fc.tuple(fc.uuid(), fc.uuid()).filter(([a, b]) => a !== b),
    async ([existing, incoming]) => {
      vi.resetAllMocks();
      vi.mocked(repo.getUserByGoogleId).mockResolvedValue(null);
      vi.mocked(repo.getUserByEmail).mockResolvedValue({ id: 'existing', email: 'same@gmail.com', googleId: existing } as never);
      await expect(loginOrCreateGoogle(incoming, 'same@gmail.com', true)).rejects.toThrow();
      expect(repo.linkGoogleIdentity).not.toHaveBeenCalled();
      expect(core.setSession).not.toHaveBeenCalled();
    },
  ), { numRuns: 50 });
});
