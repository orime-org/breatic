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
  const user = await userRepo.createUser({ email, hashedPassword });
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
      user = await userRepo.createUser({ email, googleId });
      user =
        (await userRepo.updateUser(user.id, {
          username: name,
          avatarUrl: avatar,
          emailVerified: true,
        })) ?? user;
    }
  }

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
