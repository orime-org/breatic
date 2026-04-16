/**
 * Authentication service — email/password and Google OAuth.
 *
 * Manages user registration, login, session creation/resolution,
 * and logout. Sessions are stored in Redis via the session store.
 */

import crypto from "node:crypto";
import bcrypt from "bcryptjs";

import * as userRepo from "./user.repo.js";
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
 * @param email - The user's email address
 * @param password - Plaintext password (hashed with bcrypt, 12 rounds)
 * @returns The newly created user entity
 * @throws {ConflictError} If the email is already registered
 */
export async function register(
  email: string,
  password: string,
): Promise<UserEntity> {
  const existing = await userRepo.getUserByEmail(email);
  if (existing) {
    throw new ConflictError(t("server.auth.email_taken"));
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const username = email.split("@")[0];
  const user = await userRepo.createUser({ email, hashedPassword, username });
  logger.info({ userId: user.id, email }, "user_registered");
  return user;
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

  // 每次 Google 登录都同步最新的昵称和头像
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
