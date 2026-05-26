/**
 * auth.service invariant tests — lock current behavior (PR-a task 1).
 *
 * These tests assert behavior that already exists today (per `grep`-based
 * spec amend 2026-05-26). They should pass on current `main` as-is and
 * stay green after PR-a NoAccount removal + recovery code addition.
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
vi.mock("./user.repo.js", () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: vi.fn(),
  getUserByGoogleId: vi.fn(),
  createUser: mockCreateUser,
  updateUser: vi.fn(),
  getHashedPassword: vi.fn(),
  updatePassword: mockUpdatePassword,
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

  it("when email not registered: returns silently — no throw, no sendMail, no Redis SET", async () => {
    mockGetUserByEmail.mockResolvedValue(null);

    const { forgotPassword } = await import("./auth.service.js");
    await expect(
      forgotPassword("unknown@nowhere.com", "https://app.example/reset"),
    ).resolves.toBeUndefined();

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
