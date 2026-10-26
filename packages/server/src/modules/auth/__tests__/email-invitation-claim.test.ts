// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@breatic/core";
import type * as MockModule1 from "@server/modules/auth/user.repo.js";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserEntity } from "@breatic/shared";

const mocks = vi.hoisted(() => ({
  getUserByEmail: vi.fn(),
  getUserByGoogleId: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  linkGoogleIdentity: vi.fn(),
  getHashedPassword: vi.fn(),
  claimEmailInvitations: vi.fn().mockResolvedValue(undefined),
  setSession: vi.fn().mockResolvedValue(undefined),
  redis: {},
}));

vi.mock("@server/modules/invitation/claim-email-invitations.js", () => ({
  claimEmailInvitations: mocks.claimEmailInvitations,
}));

vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn().mockResolvedValue(true) },
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof MockModule0>()),
  getRedis: () => mocks.redis,
  setSession: mocks.setSession,
  trackServerEvent: vi.fn(),
  currentConsent: () => ({ analytics: false, ads: false }),
  enqueueAdsConversion: vi.fn().mockResolvedValue(false),
}));

vi.mock("@server/modules/auth/user.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MockModule1>()),
  getUserByEmail: mocks.getUserByEmail,
  getUserByGoogleId: mocks.getUserByGoogleId,
  createUser: mocks.createUser,
  updateUser: mocks.updateUser,
  linkGoogleIdentity: mocks.linkGoogleIdentity,
  getHashedPassword: mocks.getHashedPassword,
}));

import { createAccount, loginEmail, loginOrCreateGoogle } from "@server/modules/auth/auth.service.js";

/**
 * Build the account returned by the identity repository.
 * @param emailVerified - Whether this account has proven its stored address.
 * @returns The account used by the authentication boundary.
 */
function account(emailVerified: boolean): UserEntity {
  return {
    id: "invitee",
    email: "invitee@gmail.com",
    emailVerified,
    googleId: "google-invitee",
    membershipTier: "base",
    locale: "en",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserByGoogleId.mockResolvedValue(null);
  mocks.getUserByEmail.mockResolvedValue(null);
  mocks.createUser.mockImplementation(async (data: { emailVerified?: boolean }) => account(data.emailVerified ?? false));
  mocks.updateUser.mockResolvedValue(account(true));
  mocks.getHashedPassword.mockResolvedValue("stored-password-hash");
});

describe("Google invitation claim eligibility", () => {
  it("persists an authoritative new address as verified in the account creation", async () => {
    const result = await loginOrCreateGoogle("google-invitee", "invitee@gmail.com", true);

    expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "invitee@gmail.com",
      googleId: "google-invitee",
      emailVerified: true,
    }));
    expect(result.user.emailVerified).toBe(true);
    expect(result.created).toBe(true);
    expect(mocks.setSession).toHaveBeenCalledWith(mocks.redis, result.token, "invitee");
    expect(mocks.claimEmailInvitations).toHaveBeenCalledWith(account(true));
  });

  it("persists a third-party new address as unverified", async () => {
    const result = await loginOrCreateGoogle("google-invitee", "invitee@gmail.com", false);

    expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "invitee@gmail.com",
      googleId: "google-invitee",
      emailVerified: false,
    }));
    expect(result.user.emailVerified).toBe(false);
    expect(result.created).toBe(true);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.claimEmailInvitations).not.toHaveBeenCalled();
  });
});

describe("Verified account invitation compensation", () => {
  it("claims after the verified account has been committed", async () => {
    const user = await createAccount({ locale: "en", email: "invitee@gmail.com", emailVerified: true });

    expect(user).toEqual(account(true));
    expect(mocks.claimEmailInvitations).toHaveBeenCalledWith(user);
    expect(mocks.createUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimEmailInvitations.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves an unverified account's mailbox invitations unclaimed", async () => {
    const user = await createAccount({ locale: "en", email: "invitee@gmail.com", emailVerified: false });

    expect(user).toEqual(account(false));
    expect(mocks.claimEmailInvitations).not.toHaveBeenCalled();
  });

  it("retries mailbox invitations on a verified email login", async () => {
    const user = account(true);
    mocks.getUserByEmail.mockResolvedValue(user);

    const result = await loginEmail(user.email, "correct-password");

    expect(result.user).toEqual(user);
    expect(mocks.claimEmailInvitations).toHaveBeenCalledWith(user);
    expect(mocks.setSession).toHaveBeenCalledWith(mocks.redis, result.token, user.id);
  });

  it("does not claim on an unverified email login", async () => {
    const user = account(false);
    mocks.getUserByEmail.mockResolvedValue(user);

    const result = await loginEmail(user.email, "correct-password");

    expect(result.user).toEqual(user);
    expect(mocks.claimEmailInvitations).not.toHaveBeenCalled();
    expect(mocks.setSession).toHaveBeenCalledWith(mocks.redis, result.token, user.id);
  });

  it("uses the newly verified stored identity when an existing Google account signs in", async () => {
    mocks.getUserByGoogleId.mockResolvedValue(account(false));

    const result = await loginOrCreateGoogle("google-invitee", "invitee@gmail.com", true);

    expect(result.user).toEqual(account(true));
    expect(result.created).toBe(false);
    expect(mocks.updateUser).toHaveBeenCalledWith("invitee", { emailVerified: true });
    expect(mocks.claimEmailInvitations).toHaveBeenCalledWith(account(true));
    expect(mocks.updateUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimEmailInvitations.mock.invocationCallOrder[0]!,
    );
  });

  it("claims for an already verified account on a non-authoritative Google login", async () => {
    mocks.getUserByGoogleId.mockResolvedValue(account(true));

    const result = await loginOrCreateGoogle("google-invitee", "invitee@gmail.com", false);

    expect(result.user).toEqual(account(true));
    expect(mocks.claimEmailInvitations).toHaveBeenCalledWith(account(true));
  });

  it("keeps the old stored address unverified when Google's address differs", async () => {
    const user = { ...account(false), email: "old@example.test" };
    mocks.getUserByGoogleId.mockResolvedValue(user);

    const result = await loginOrCreateGoogle("google-invitee", "new@gmail.com", true);

    expect(result.user).toEqual(user);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.claimEmailInvitations).not.toHaveBeenCalled();
  });
});
