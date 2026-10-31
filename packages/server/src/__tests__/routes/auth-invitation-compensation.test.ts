// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@server/modules";
import type * as MockModule1 from "@server/modules/auth/user.repo.js";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { UserEntity } from "@breatic/shared";

vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

const spies = vi.hoisted(() => ({
  verifySignupCode: vi.fn(),
  claimEmailInvitations: vi.fn().mockResolvedValue(undefined),
  getUserById: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => ({
  ...(await importOriginal<typeof MockModule0>()),
  signupCodeService: {
    emailVerificationEnabled: () => true,
    verifySignupCode: spies.verifySignupCode,
  },
}));

vi.mock("@server/modules/auth/user.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MockModule1>()),
  getUserById: spies.getUserById,
}));

vi.mock("@server/modules/invitation/claim-email-invitations.js", () => ({
  claimEmailInvitations: spies.claimEmailInvitations,
}));

import { authRoute } from "@server/routes/auth.js";
import { signupTicketCookieName } from "@server/middleware/session-cookie.js";
import { LOOPBACK_PEER } from "@server/__tests__/helpers/peer.js";

const USER: UserEntity = {
  id: "verified-signup", email: "new@example.test", emailVerified: true,
  googleId: null, locale: "en", membershipTier: "base",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"), deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  spies.verifySignupCode.mockResolvedValue(USER);
  spies.getUserById.mockResolvedValue(USER);
});

describe("verified signup session invitation compensation", () => {
  it("retries verified mailbox invitations when the signup verification issues its session", async () => {
    const app = new Hono().route("/auth", authRoute);
    const response = await app.request("/auth/register/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${signupTicketCookieName()}=signup-ticket`,
      },
      body: JSON.stringify({ code: "123456" }),
    }, LOOPBACK_PEER);

    expect(response.status).toBe(201);
    expect(spies.verifySignupCode).toHaveBeenCalledWith("signup-ticket", "123456", null);
    expect(spies.claimEmailInvitations).toHaveBeenCalledWith(USER);
    const body = await response.json() as { data: { user: { id: string; personalStudio: null } } };
    expect(body.data.user.id).toBe("verified-signup");
    expect(body.data.user.personalStudio).toBeNull();
    expect(response.headers.get("Set-Cookie")).toContain("breatic_session=");
  });
});
