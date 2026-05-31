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

const mockRedis = {
  set: vi.fn().mockResolvedValue("OK"),
  get: vi.fn(),
  del: vi.fn().mockResolvedValue(1),
};
vi.mock("../infra/redis.js", () => ({
  getRedis: () => mockRedis,
}));

const mockDeleteAllSessions = vi.fn();
vi.mock("../infra/session-store.js", () => ({
  setSession: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteAllSessions: mockDeleteAllSessions,
}));

const mockSendMail = vi.fn().mockResolvedValue(true);
vi.mock("../infra/mailer.js", () => ({
  sendMail: mockSendMail,
}));

const mockGetUserByEmail = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdatePassword = vi.fn();
const mockSetRecoveryCode = vi.fn().mockResolvedValue(undefined);
vi.mock("./user.repo.js", () => ({
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

vi.mock("./studio.service.js", () => ({
  ensurePersonalStudio: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  env: { ENV: "test" },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@breatic/shared", () => ({
  t: (k: string) => k,
}));

describe("auth.service invariant — BCRYPT_ROUNDS = 12 (锁现状回归)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("register() produces bcrypt hash with cost-12 prefix", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    let capturedHash: string | undefined;
    mockCreateUser.mockImplementation(async (data: { hashedPassword?: string; email: string; username: string }) => {
      capturedHash = data.hashedPassword;
      return { id: "u-new", email: data.email, username: data.username, avatarUrl: null, credits: 0 };
    });

    const { register } = await import("./auth.service.js");
    await register("new@example.com", "validPassword123");

    expect(capturedHash).toBeDefined();
    expect(capturedHash).toMatch(/^\$2[abxy]\$12\$/);
  });

  it("Q10 invariant: register(email, password, name) writes users.username = name (not email prefix)", async () => {
    // RegisterPage already collects a `name` field (auth.nameRequired
    // validation, autoComplete='name'). The server previously stripped
    // it via the registerSchema = z.object({email, password}) zod
    // shape, falling back to `email.split("@")[0]` — so a user typing
    // "Justin" at sign-up landed in PG as username="justin@…prefix".
    // This invariant locks the full passthrough so any future regression
    // (schema reset / route destructure drop / service-arg removal)
    // trips the test before merge.
    mockGetUserByEmail.mockResolvedValue(null);
    let capturedUsername: string | undefined;
    mockCreateUser.mockImplementation(async (data: { username: string; email: string; hashedPassword?: string }) => {
      capturedUsername = data.username;
      return { id: "u-justin", email: data.email, username: data.username, avatarUrl: null, credits: 0 };
    });

    const { register } = await import("./auth.service.js");
    await register("justin@example.com", "validPassword123", "Justin");

    expect(capturedUsername).toBe("Justin");
    // Defensive: lock out the legacy email-prefix fallback so a revert
    // is loud, not silent.
    expect(capturedUsername).not.toBe("justin");
  });

  it("Q10 invariant: register(email, password) without name still falls back to email prefix (back-compat)", async () => {
    // Old clients that have not yet redeployed continue to call
    // register without a name. The service must keep working
    // (back-compat) and just use the legacy fallback.
    mockGetUserByEmail.mockResolvedValue(null);
    let capturedUsername: string | undefined;
    mockCreateUser.mockImplementation(async (data: { username: string; email: string }) => {
      capturedUsername = data.username;
      return { id: "u-old", email: data.email, username: data.username, avatarUrl: null, credits: 0 };
    });

    const { register } = await import("./auth.service.js");
    await register("nameless@example.com", "validPassword123");

    expect(capturedUsername).toBe("nameless");
  });

  it("register() returns recoveryCode (XXXX-XXXX-XXXX-XXXX) + setRecoveryCode stores cost-12 bcrypt hash", async () => {
    mockGetUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: "u-new",
      email: "new@example.com",
      username: "new",
      avatarUrl: null,
      credits: 0,
    });

    const { register } = await import("./auth.service.js");
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

    const { resetPassword } = await import("./auth.service.js");
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

    const { forgotPassword } = await import("./auth.service.js");
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
      username: "user",
      avatarUrl: null,
      credits: 0,
    });

    const { forgotPassword } = await import("./auth.service.js");
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

    const { resetPassword } = await import("./auth.service.js");
    await expect(
      resetPassword("expired-or-invalid-token", "newPassword123"),
    ).rejects.toThrow();

    expect(mockUpdatePassword).not.toHaveBeenCalled();
    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(mockDeleteAllSessions).not.toHaveBeenCalled();
  });

  it("on success: updatePassword + Redis DEL + deleteAllSessions all called (atomic semantics — no partial cleanup)", async () => {
    mockRedis.get.mockResolvedValue("u-1");

    const { resetPassword } = await import("./auth.service.js");
    await resetPassword("valid-token", "newPassword123");

    expect(mockUpdatePassword).toHaveBeenCalledOnce();
    expect(mockRedis.del).toHaveBeenCalledOnce();
    const delKey = mockRedis.del.mock.calls[0]?.[0] as string;
    expect(delKey).toMatch(/^test:password-reset:valid-token$/);
    expect(mockDeleteAllSessions).toHaveBeenCalledOnce();
  });
});
