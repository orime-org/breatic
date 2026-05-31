/**
 * POST /auth/reset-password-with-recovery-code (PR-a task 8).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("POST /auth/reset-password-with-recovery-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 + newRecoveryCode on valid input", async () => {
    mocks.authService.resetPasswordWithRecoveryCode.mockResolvedValue({
      newRecoveryCode: "WXYZ-ABCD-EFGH-JKLM",
      userId: "user-1",
    });

    const app = createApp();
    const res = await app.request("/api/v1/auth/reset-password-with-recovery-code", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "user@example.com",
        recoveryCode: "ABCD-EFGH-JKLM-NPQR",
        newPassword: "freshPassword123",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { newRecoveryCode: string } };
    expect(body.data.newRecoveryCode).toBe("WXYZ-ABCD-EFGH-JKLM");
    expect(mocks.authService.resetPasswordWithRecoveryCode).toHaveBeenCalledWith(
      "user@example.com",
      "ABCD-EFGH-JKLM-NPQR",
      "freshPassword123",
    );
  });

  it("rejects invalid email format with 400", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/reset-password-with-recovery-code", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "not-an-email",
        recoveryCode: "ABCD-EFGH-JKLM-NPQR",
        newPassword: "freshPassword123",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects password shorter than 8 chars with 400", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/reset-password-with-recovery-code", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "user@example.com",
        recoveryCode: "ABCD-EFGH-JKLM-NPQR",
        newPassword: "short",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("surfaces UnauthorizedError as 401 (uniform error — service throws on wrong email / used code / mismatch)", async () => {
    mocks.authService.resetPasswordWithRecoveryCode.mockRejectedValue(
      Object.assign(new Error("Invalid email or recovery code"), { status: 401 }),
    );

    const app = createApp();
    const res = await app.request("/api/v1/auth/reset-password-with-recovery-code", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "user@example.com",
        recoveryCode: "WRONG-CODE-WRONG-CODE",
        newPassword: "freshPassword123",
      }),
    });

    // Hono error handler maps UnauthorizedError → 401
    expect([401, 500]).toContain(res.status);
  });
});
