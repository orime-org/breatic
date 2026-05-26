/**
 * Authentication service — email/password and Google OAuth.
 *
 * Manages user registration, login, session creation/resolution,
 * and logout. Sessions are stored in Redis via the session store.
 */

import crypto from "node:crypto";
import bcrypt from "bcryptjs";

import * as userRepo from "./user.repo.js";
import * as studioService from "./studio.service.js";
import {
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./recovery-code.service.js";
import { getRedis } from "../infra/redis.js";
import { sendMail } from "../infra/mailer.js";
import { env } from "../config/env.js";
import {
  setSession,
  getSession,
  deleteSession,
  deleteAllSessions,
} from "../infra/session-store.js";
import {
  ConflictError,
  UnauthorizedError,
} from "../errors.js";
import { logger } from "../logger.js";
import { t } from "@breatic/shared";
import type { UserEntity } from "@breatic/shared";

const BCRYPT_ROUNDS = 12;

/**
 * Register a new user with email and password.
 *
 * Generates a one-time recovery code (GitHub backup-codes pattern) so
 * the user can reset their password without an SMTP backend
 * (self-host friendly). The plaintext code is returned exactly once
 * — callers MUST display it to the user with a "save this now" UX;
 * only the bcrypt hash is persisted server-side.
 *
 * @param email - The user's email address
 * @param password - Plaintext password (hashed with bcrypt, 12 rounds)
 * @returns `{ user, recoveryCode }` — recoveryCode is plaintext
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
  const username = email.split("@")[0];
  const user = await userRepo.createUser({ email, hashedPassword, username });

  // Generate + store recovery code. Done after createUser so we have
  // a user.id to attach to. Failures here bubble up before studio
  // setup — the user row will still exist (no transaction wrap) but
  // recovery_code_hash will be NULL; the user can request a fresh
  // code via reset-with-recovery-code → resend flow.
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await hashRecoveryCode(recoveryCode);
  await userRepo.setRecoveryCode(user.id, recoveryCodeHash);

  // Personal studio is the FK target for the user's projects (v10
  // §6). Idempotent — also called from project.service.create as
  // belt-and-suspenders if the register hook ever races.
  await studioService.ensurePersonalStudio(user.id, user.username);
  logger.info({ userId: user.id, email }, "user_registered");
  return { user, recoveryCode };
}

/**
 * Authenticate a user via email and password.
 *
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
  logger.info({ userId: user.id, method: "email" }, "user_logged_in");
  return { user, token };
}

/**
 * Log in or register a user via Google OAuth.
 *
 * If a user with the given Google ID exists, logs them in. Otherwise,
 * links to an existing email account or creates a new user.
 *
 * @param googleId - The Google account identifier
 * @param email - The email address from Google
 * @param name - Display name from Google (optional)
 * @param avatar - Avatar URL from Google (optional)
 * @returns The user and a session token
 */
export async function loginOrCreateGoogle(
  googleId: string,
  email: string,
  name?: string,
  avatar?: string,
): Promise<{ user: UserEntity; token: string }> {
  let user = await userRepo.getUserByGoogleId(googleId);

  if (!user) {
    // Check if email already registered — link accounts
    user = await userRepo.getUserByEmail(email);
    if (user) {
      user =
        (await userRepo.updateUser(user.id, { googleId })) ?? user;
    } else {
      user = await userRepo.createUser({ email, googleId, username: name || email.split("@")[0] });
    }
  }
  // Ensure personal studio exists for both newly-created and linked
  // accounts. Idempotent — also called from project.service.create.
  await studioService.ensurePersonalStudio(user.id, user.username);

  // Sync the latest nickname + avatar on every Google sign-in
  const updates: Parameters<typeof userRepo.updateUser>[1] = { emailVerified: true };
  if (name && !user.username) updates.username = name;
  if (avatar) updates.avatarUrl = avatar;
  user = (await userRepo.updateUser(user.id, updates)) ?? user;

  const token = crypto.randomUUID();
  const redis = getRedis();
  await setSession(redis, token, user.id);
  logger.info({ userId: user.id, method: "google" }, "user_logged_in");
  return { user, token };
}

/**
 * Resolve a session token to a user.
 *
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
 *
 * @param token - The session token to revoke
 */
export async function logout(token: string): Promise<void> {
  const redis = getRedis();
  await deleteSession(redis, token);
}

/**
 * Invalidate all sessions for a user (logout everywhere).
 *
 * @param userId - The ID of the user whose sessions should be revoked
 */
export async function logoutAll(userId: string): Promise<void> {
  const redis = getRedis();
  await deleteAllSessions(redis, userId);
}

const RESET_TOKEN_TTL = 3600; // 1 hour

/**
 * Generate a password reset token and send reset email.
 *
 * Silently succeeds even if email not found (prevents email enumeration).
 */
export async function forgotPassword(email: string, resetBaseUrl: string): Promise<void> {
  const user = await userRepo.getUserByEmail(email);
  if (!user) {
    logger.info({ email }, "Password reset requested for non-existent email");
    return; // Don't reveal whether email exists
  }

  const token = crypto.randomBytes(32).toString("hex");
  const redis = getRedis();
  const key = `${env.ENV}:password-reset:${token}`;
  await redis.set(key, user.id, "EX", RESET_TOKEN_TTL);

  const resetUrl = `${resetBaseUrl}?token=${token}`;
  await sendMail({
    to: email,
    subject: "Breatic — Reset your password",
    html: `
      <p>You requested a password reset.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
    `,
  });

  logger.info({ userId: user.id }, "Password reset email sent");
}

/**
 * Verify reset token and update password.
 *
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

  logger.info({ userId }, "Password reset completed");
}

/**
 * Reset password using the one-time recovery code shown at
 * registration. No email backend required — designed for self-host
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
 *   6. Generate + store a fresh recovery code (rotate-on-use —
 *      old one cannot reset again, new one shown to user)
 *   7. deleteAllSessions (force re-login on all devices)
 *   8. Return the new plaintext code (shown once — frontend MUST
 *      re-prompt user to save it)
 *
 * @returns `{ newRecoveryCode }` — fresh plaintext code to display
 * @throws {UnauthorizedError} on any failure (uniform error to
 *   prevent oracle attacks on email vs. code)
 */
export async function resetPasswordWithRecoveryCode(
  email: string,
  code: string,
  newPassword: string,
): Promise<{ newRecoveryCode: string }> {
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

  logger.info({ userId: user.id }, "password_reset_via_recovery_code");
  return { newRecoveryCode };
}
