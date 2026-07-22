// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 *
 *   5. register seeds credit_balances — every new user gets a balance
 *      row via creditRepo.createBalanceRow(user.id) (PR3 moved credits
 *      out of the users table into credit_balances). Defends against a
 *      regression that would leave new users with no balance row, which
 *      would make the auth middleware's getBalance throw on their first
 *      request.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
    getRedis: () => mockRedis,
    setSession: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteAllSessions: mockDeleteAllSessions,
    env: { ENV: "test" },
  };
});

// creditRepo.createBalanceRow moved to @breatic/domain (PR4). Mock it
// EXPLICITLY (no importOriginal) so loading it never pulls the real agent
// llm → `ai` SDK → otel ESM chain (which crashes under vitest).
const mockCreateBalanceRow = vi.fn().mockResolvedValue(undefined);
vi.mock("@breatic/domain", () => ({
  creditRepo: {
    createBalanceRow: mockCreateBalanceRow,
    getBalance: vi.fn(),
    deductBalance: vi.fn(),
    addBalance: vi.fn(),
    recordTransaction: vi.fn(),
    listTransactionsByUser: vi.fn(),
  },
}));

const mockSendMail = vi.fn().mockResolvedValue(true);
vi.mock("@server/infra/mailer.js", () => ({
  sendMail: mockSendMail,
}));

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

  it("register() seeds a credit_balances row for the new user (PR3 atomic-balance invariant)", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: "u-new",
      email: "new@example.com",
    });

    const { register } = await import("../auth.service.js");
    await register("new@example.com", "validPassword123");

    // PR3 moved credits out of the users table into credit_balances;
    // every newly-registered user must get a balance row seeded so the
    // auth middleware's creditRepo.getBalance resolves on first request.
    expect(mockCreateBalanceRow).toHaveBeenCalledOnce();
    expect(mockCreateBalanceRow).toHaveBeenCalledWith("u-new");
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

  it("loginOrCreateGoogle takes ONLY (googleId, email) — never imports Google name/avatar, only syncs email_verified", async () => {
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
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const userRepo = await import("@server/modules/auth/user.repo.js");
    vi.mocked(userRepo.getUserByGoogleId).mockResolvedValue(existing);
    let capturedUpdate: Record<string, unknown> | undefined;
    vi.mocked(userRepo.updateUser).mockImplementation(async (_id, data) => {
      capturedUpdate = data as Record<string, unknown>;
      return existing;
    });

    const { loginOrCreateGoogle } = await import("../auth.service.js");
    // The signature is (googleId, email) — TS would reject a 3rd/4th arg.
    await loginOrCreateGoogle("g-1", "g@x.com");

    expect(capturedUpdate).toEqual({ emailVerified: true });
    expect(Object.keys(capturedUpdate!)).toEqual(["emailVerified"]);
    // No personal studio is created in the OAuth path (slug-setup handles it).
    expect(mockCreatePersonalStudio).not.toHaveBeenCalled();
  });
});
