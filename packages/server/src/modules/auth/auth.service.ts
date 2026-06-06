// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Authentication service - email/password and Google OAuth.
 *
 * Manages user registration, login, session creation/resolution,
 * and logout. Sessions are stored in Redis via the session store.
 */

import crypto from "node:crypto";
import bcrypt from "bcryptjs";

import * as userRepo from "@server/modules/auth/user.repo.js";
import { creditRepo } from "@breatic/domain";
import {
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "@server/modules/auth/recovery-code.service.js";
import { getRedis } from "@breatic/core";
import { sendMail, type SendMailResult } from "@server/infra/mailer.js";
import { env } from "@breatic/core";
import {
  setSession,
  getSession,
  deleteSession,
  deleteAllSessions,
} from "@breatic/core";
import {
  ConflictError,
  UnauthorizedError,
} from "@breatic/core";
import { t } from "@breatic/shared";
import type { UserEntity } from "@breatic/shared";

const BCRYPT_ROUNDS = 12;

/**
 * Register a new user with email and password (step 1 of 2).
 *
 * Creates the pure account row (no display name, no personal studio) +
 * the credit balance row + a one-time recovery code. The personal studio
 * — which carries the user's display name + URL handle — is created in
 * the SECOND step (`setup-studio`) once the user picks a slug. Until then
 * `/auth/me` reports `personalStudio: null` and the frontend gate forces
 * the slug-setup page (email-registration rewrite, 2026-06-06).
 *
 * The recovery code (GitHub backup-codes pattern) lets the user reset
 * their password without an SMTP backend (self-host friendly). The
 * plaintext code is returned exactly once — callers MUST display it with
 * a "save this now" UX; only the bcrypt hash is persisted server-side.
 * @param email - The user's email address
 * @param password - Plaintext password (hashed with bcrypt, 12 rounds)
 * @returns `{ user, recoveryCode }` - recoveryCode is plaintext
 *   `XXXX-XXXX-XXXX-XXXX`, shown once.
 * @throws {ConflictError} If the email is already registered
 */
export async function register(
  email: string,
  password: string,
): Promise<{ user: UserEntity; recoveryCode: string }> {
  const existing = await userRepo.getUserByEmail(email);
  if (existing) {
    throw new ConflictError(t("server.auth.email_taken"));
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await userRepo.createUser({ email, hashedPassword });
  await creditRepo.createBalanceRow(user.id);

  // Generate + store recovery code. Done after createUser so we have
  // a user.id to attach to. Failures here bubble up; the user row will
  // still exist (no transaction wrap) but recovery_code_hash will be
  // NULL — the user can request a fresh code via the
  // reset-with-recovery-code → resend flow.
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await hashRecoveryCode(recoveryCode);
  await userRepo.setRecoveryCode(user.id, recoveryCodeHash);

  // NO personal studio here — that is the user's explicit second step
  // (setup-studio), where they choose their slug. Per CLAUDE.md
  // "core and shared must not log", the caller logs the `user_registered`
  // audit line after this resolves.
  return { user, recoveryCode };
}

/**
 * Authenticate a user via email and password.
 * @param email - The user's email address
 * @param password - Plaintext password to verify
 * @returns The authenticated user and a session token
 * @throws {UnauthorizedError} If credentials are invalid
 */
export async function loginEmail(
  email: string,
  password: string,
): Promise<{ user: UserEntity; token: string }> {
  const user = await userRepo.getUserByEmail(email);
  if (!user) {
    throw new UnauthorizedError(t("server.auth.invalid_credentials"));
  }

  const hashed = await userRepo.getHashedPassword(user.id);
  if (!hashed) {
    throw new UnauthorizedError(t("server.auth.invalid_credentials"));
  }

  const valid = await bcrypt.compare(password, hashed);
  if (!valid) {
    throw new UnauthorizedError(t("server.auth.invalid_credentials"));
  }

  const token = crypto.randomUUID();
  const redis = getRedis();
  await setSession(redis, token, user.id);
  // Caller logs `user_logged_in` (method=email) audit line.
  return { user, token };
}

/**
 * Log in or register a user via Google OAuth.
 *
 * If a user with the given Google ID exists, logs them in. Otherwise,
 * links to an existing email account or creates a new account (no
 * personal studio — like email step 1). When OAuth gets a real UI, the
 * new user will hit the same "no personal studio → pick a slug" gate as
 * email sign-ups (email-registration rewrite, 2026-06-06). Today the
 * Google button is a coming-soon placeholder; this path only stays
 * compile-clean + consistent.
 * @param googleId - The Google account identifier
 * @param email - The email address from Google
 * @param name - Display name from Google (currently unused — display name
 *   lives on the personal studio, created in the slug-setup step)
 * @param avatar - Avatar URL from Google (optional)
 * @returns The user and a session token
 */
export async function loginOrCreateGoogle(
  googleId: string,
  email: string,
  name?: string,
  avatar?: string,
): Promise<{ user: UserEntity; token: string }> {
  void name; // reserved for the future OAuth onboarding UI (slug-setup step)
  let user = await userRepo.getUserByGoogleId(googleId);

  if (!user) {
    // Check if email already registered - link accounts
    user = await userRepo.getUserByEmail(email);
    if (user) {
      user =
        (await userRepo.updateUser(user.id, { googleId })) ?? user;
    } else {
      user = await userRepo.createUser({ email, googleId });
      await creditRepo.createBalanceRow(user.id);
    }
  }

  // Sync the latest avatar + verified flag on every Google sign-in. No
  // personal studio is created here — the slug-setup gate handles that.
  const updates: Parameters<typeof userRepo.updateUser>[1] = { emailVerified: true };
  if (avatar) updates.avatarUrl = avatar;
  user = (await userRepo.updateUser(user.id, updates)) ?? user;

  const token = crypto.randomUUID();
  const redis = getRedis();
  await setSession(redis, token, user.id);
  // Caller logs `user_logged_in` (method=google) audit line.
  return { user, token };
}

/**
 * Look up a single user by id.
 *
 * Thin pass-through to the user repository so route handlers reach
 * the data layer through the service (prohibition #1).
 * @param userId - The user UUID to resolve
 * @returns The matching {@link UserEntity}, or null if not found / soft-deleted
 */
export async function getUserById(userId: string): Promise<UserEntity | null> {
  return userRepo.getUserById(userId);
}

/**
 * Look up many users by id in one query.
 *
 * Thin pass-through to the user repository so route handlers reach
 * the data layer through the service (prohibition #1).
 * @param ids - User UUIDs to resolve (soft-deleted / missing ids are dropped)
 * @returns The matching {@link UserEntity} rows in arbitrary order
 */
export async function getUsersByIds(ids: string[]): Promise<UserEntity[]> {
  return userRepo.getUsersByIds(ids);
}

/**
 * Resolve a session token to a user.
 * @param token - The session token string
 * @returns The corresponding user entity, or null if invalid/expired
 */
export async function getUserByToken(
  token: string,
): Promise<UserEntity | null> {
  const redis = getRedis();
  const userId = await getSession(redis, token);
  if (!userId) return null;
  return userRepo.getUserById(userId);
}

/**
 * Invalidate a single session.
 * @param token - The session token to revoke
 */
export async function logout(token: string): Promise<void> {
  const redis = getRedis();
  await deleteSession(redis, token);
}

/**
 * Invalidate all sessions for a user (logout everywhere).
 * @param userId - The ID of the user whose sessions should be revoked
 */
export async function logoutAll(userId: string): Promise<void> {
  const redis = getRedis();
  await deleteAllSessions(redis, userId);
}

const RESET_TOKEN_TTL = 3600; // 1 hour

/**
 * Discriminated outcome of {@link forgotPassword}. Per CLAUDE.md
 * "core and shared must not log" mandate, the service returns the
 * branch it took (anti-enumeration: caller still responds to the
 * client with the same generic body) and the route handler logs
 * the appropriate audit line.
 */
export type ForgotPasswordResult =
  | { status: "unknown_email" }
  | { status: "reset_email_sent"; userId: string; mailResult: SendMailResult };

/**
 * Generate a password reset token and send reset email.
 *
 * Silently succeeds even if email not found (prevents email
 * enumeration). The returned discriminant lets the caller log
 * audit context internally without ever leaking the
 * existence/non-existence of the email back to the client.
 * @param email - Email address the reset was requested for
 * @param resetBaseUrl - Base URL the reset token is appended to in the email link
 * @returns `{ status: "unknown_email" }` when no user matches, otherwise
 *   `{ status: "reset_email_sent", userId, mailResult }` for audit logging
 */
export async function forgotPassword(
  email: string,
  resetBaseUrl: string,
): Promise<ForgotPasswordResult> {
  const user = await userRepo.getUserByEmail(email);
  if (!user) {
    return { status: "unknown_email" };
  }

  const token = crypto.randomBytes(32).toString("hex");
  const redis = getRedis();
  const key = `${env.ENV}:password-reset:${token}`;
  await redis.set(key, user.id, "EX", RESET_TOKEN_TTL);

  const resetUrl = `${resetBaseUrl}?token=${token}`;
  const mailResult = await sendMail({
    to: email,
    subject: "Breatic - Reset your password",
    html: `
      <p>You requested a password reset.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
    `,
  });

  return { status: "reset_email_sent", userId: user.id, mailResult };
}

/**
 * Verify reset token and update password.
 * @param token - One-time reset token from the email link
 * @param newPassword - New plaintext password to hash and store
 * @throws {UnauthorizedError} if token is invalid or expired
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const redis = getRedis();
  const key = `${env.ENV}:password-reset:${token}`;
  const userId = await redis.get(key);

  if (!userId) {
    throw new UnauthorizedError("Invalid or expired reset token");
  }

  const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await userRepo.updatePassword(userId, hashed);

  // Delete the token so it can't be reused
  await redis.del(key);

  // Invalidate all existing sessions (security: force re-login)
  await deleteAllSessions(redis, userId);

  // Caller logs `password_reset_completed` audit line (userId
  // returned via the calling route's request context).
}

/**
 * Reset password using the one-time recovery code shown at
 * registration. No email backend required - designed for self-host
 * installs where `EMAIL_BACKEND=disabled`.
 *
 * Flow:
 *   1. Find user by email; reject generically if not found
 *      (avoids leaking account existence vs. wrong-code)
 *   2. Load stored recovery_code_hash + used_at;
 *      reject if no code stored or already used
 *   3. bcrypt.compare(code, hash); reject on mismatch
 *   4. Update password (bcrypt cost 12, same as `resetPassword`)
 *   5. markRecoveryCodeUsed (used_at = now)
 *   6. Generate + store a fresh recovery code (rotate-on-use -
 *      old one cannot reset again, new one shown to user)
 *   7. deleteAllSessions (force re-login on all devices)
 *   8. Return the new plaintext code (shown once - frontend MUST
 *      re-prompt user to save it)
 * @param email - Email address the reset is requested for
 * @param code - Plaintext recovery code the user supplied
 * @param newPassword - New plaintext password to hash and store
 * @returns `{ newRecoveryCode }` - fresh plaintext code to display
 * @throws {UnauthorizedError} on any failure (uniform error to
 *   prevent oracle attacks on email vs. code)
 */
export async function resetPasswordWithRecoveryCode(
  email: string,
  code: string,
  newPassword: string,
): Promise<{ newRecoveryCode: string; userId: string }> {
  const user = await userRepo.getUserByEmail(email);
  if (!user) {
    throw new UnauthorizedError("Invalid email or recovery code");
  }

  const stored = await userRepo.getRecoveryCode(user.id);
  if (!stored || stored.usedAt !== null) {
    throw new UnauthorizedError("Invalid email or recovery code");
  }

  const valid = await verifyRecoveryCode(code, stored.hash);
  if (!valid) {
    throw new UnauthorizedError("Invalid email or recovery code");
  }

  // 1. Update password (bcrypt cost 12).
  const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await userRepo.updatePassword(user.id, hashedPassword);

  // 2. Mark current code consumed.
  await userRepo.markRecoveryCodeUsed(user.id);

  // 3. Rotate to fresh code (return plaintext to caller).
  const newRecoveryCode = generateRecoveryCode();
  const newHash = await hashRecoveryCode(newRecoveryCode);
  await userRepo.setRecoveryCode(user.id, newHash);

  // 4. Force re-login (security: all existing tokens revoked).
  const redis = getRedis();
  await deleteAllSessions(redis, user.id);

  // Caller logs `password_reset_via_recovery_code` audit line.
  return { newRecoveryCode, userId: user.id };
}

// ── Email verification ───────────────────────────────────────────

const EMAIL_VERIFY_TTL = 24 * 3600; // 24 hours

/**
 * Generate a one-time email-verification token (PR-a task 9).
 *
 * Stored in Redis (`${env.ENV}:email-verify:{token}` → userId) with
 * 24h TTL. Caller is responsible for sending the user a link that
 * embeds the returned token. Auto-removed on consume or expiry.
 * @param userId - User the verification token is issued for
 * @returns The 64-char hex token to embed in the verify URL.
 */
export async function generateVerifyEmailToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const redis = getRedis();
  const key = `${env.ENV}:email-verify:${token}`;
  await redis.set(key, userId, "EX", EMAIL_VERIFY_TTL);
  return token;
}

/**
 * Consume an email-verification token (PR-a task 9).
 *
 * Looks up the token in Redis, flips `users.email_verified = true`
 * for the resolved user, deletes the token (single-use), and logs.
 * @param token - One-time email-verification token from the verify link
 * @returns `{ userId }` of the user whose email was verified (for audit logging)
 * @throws {UnauthorizedError} if the token is missing / expired / used.
 */
export async function verifyEmail(token: string): Promise<{ userId: string }> {
  const redis = getRedis();
  const key = `${env.ENV}:email-verify:${token}`;
  const userId = await redis.get(key);
  if (!userId) {
    throw new UnauthorizedError("Invalid or expired verification token");
  }
  await userRepo.updateUser(userId, { emailVerified: true });
  await redis.del(key);
  // Caller logs `email_verified` audit line with the returned userId.
  return { userId };
}

/**
 * Resend the verification email for a given user (PR-a task 9).
 *
 * Generates a fresh token (invalidating any previous tokens once the
 * key collides - extremely unlikely, but functionally a no-op since
 * each token is fresh-random and TTL'd) and dispatches via the
 * configured mailer backend. Caller decides whether the user is
 * already verified (skip in that case).
 *
 * Only meaningful when `env.EMAIL_BACKEND !== "disabled"` - caller
 * should gate accordingly; this function will still run (Redis token
 * stored) but `sendMail` will no-op + return false in disabled mode.
 * @param userId - User the fresh verification token is issued for
 * @param email - Destination address for the verification email
 * @param verifyBaseUrl - Base URL the verify token is appended to in the email link
 * @returns `{ mailResult }` reporting whether the mailer dispatched the email
 */
export async function resendVerificationEmail(
  userId: string,
  email: string,
  verifyBaseUrl: string,
): Promise<{ mailResult: SendMailResult }> {
  const token = await generateVerifyEmailToken(userId);
  const verifyUrl = `${verifyBaseUrl}?token=${token}`;
  const mailResult = await sendMail({
    to: email,
    subject: "Breatic - Verify your email",
    html: `
      <p>Welcome to Breatic. Click below to verify your email address:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>This link expires in 24 hours. If you didn't request this, you can ignore this email.</p>
    `,
  });
  // Caller logs `verification_email_sent` + mail result audit line.
  return { mailResult };
}
