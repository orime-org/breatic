// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * User repository — data access for the users table.
 *
 * Handles CRUD operations and atomic credit modifications.
 */

import { eq, and, isNull, inArray } from "drizzle-orm";
import { db } from "@breatic/core";
import { users } from "@breatic/core";
import type { UserEntity } from "@breatic/shared";

/**
 * Convert a Drizzle row to a UserEntity (strips hashed_password).
 * @param row - Raw `users` table row from a Drizzle select
 * @returns The public user entity with the password hash omitted
 */
function toEntity(row: typeof users.$inferSelect): UserEntity {
  return {
    id: row.id,
    email: row.email,
    avatarUrl: row.avatarUrl,
    emailVerified: row.emailVerified,
    googleId: row.googleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Find a user by ID (excludes soft-deleted).
 * @param userId - User UUID to look up
 * @returns The user entity, or null if not found or soft-deleted
 */
export async function getUserById(userId: string): Promise<UserEntity | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Look up many users by id in one query (excludes soft-deleted).
 *
 * Returns rows in arbitrary order — caller is expected to map by
 * id. Backs `GET /api/v1/users?ids=` (the frontend joins
 * `useProjectMembers` with display info).
 * @param ids - Up to 100 user UUIDs (caller caps the input)
 * @returns Matching user entities in arbitrary order (empty array for empty input)
 */
export async function getUsersByIds(ids: string[]): Promise<UserEntity[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.deletedAt)));
  return rows.map(toEntity);
}

/**
 * Find a user by email (excludes soft-deleted).
 * @param email - Email address to look up
 * @returns The user entity, or null if not found or soft-deleted
 */
export async function getUserByEmail(email: string): Promise<UserEntity | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Find a user by Google ID (excludes soft-deleted).
 * @param googleId - Google account identifier to look up
 * @returns The user entity, or null if not found or soft-deleted
 */
export async function getUserByGoogleId(googleId: string): Promise<UserEntity | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.googleId, googleId), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Get the hashed password for login verification.
 * @param userId - User UUID whose stored password hash to fetch
 * @returns The bcrypt hash, or null if the user has no password (OAuth-only) or no row
 */
export async function getHashedPassword(userId: string): Promise<string | null> {
  const rows = await db
    .select({ hashedPassword: users.hashedPassword })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.hashedPassword ?? null;
}

/**
 * Create a new user.
 * @param data - User fields to insert
 * @param data.email - Email address (unique per active user)
 * @param data.hashedPassword - Optional bcrypt password hash (absent for OAuth-only sign-ups)
 * @param data.googleId - Optional linked Google account identifier
 * @returns The created UserEntity
 */
export async function createUser(data: {
  email: string;
  hashedPassword?: string;
  googleId?: string;
}): Promise<UserEntity> {
  const rows = await db
    .insert(users)
    .values({
      email: data.email,
      hashedPassword: data.hashedPassword,
      googleId: data.googleId,
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Update user profile fields.
 * @param userId - User UUID to update
 * @param data - Partial set of profile fields to overwrite (avatarUrl / emailVerified / googleId)
 * @returns The updated user entity, or null if no row matched
 */
export async function updateUser(
  userId: string,
  data: Partial<Pick<typeof users.$inferInsert, "avatarUrl" | "emailVerified" | "googleId">>,
): Promise<UserEntity | null> {
  const rows = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Update a user's hashed password.
 * @param userId - User UUID whose password to replace
 * @param hashedPassword - New bcrypt password hash to store
 */
export async function updatePassword(userId: string, hashedPassword: string): Promise<void> {
  await db
    .update(users)
    .set({ hashedPassword, updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
}

/**
 * Set / replace the user's recovery code hash and clear `used_at`.
 *
 * Called at registration (initial code) and after a successful
 * recovery-code-based password reset (rotate to a fresh code).
 * @param userId - User UUID whose recovery code to set
 * @param recoveryCodeHash - Bcrypt hash of the new recovery code
 */
export async function setRecoveryCode(
  userId: string,
  recoveryCodeHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({
      recoveryCodeHash,
      recoveryCodeUsedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
}

/**
 * Fetch the recovery code hash + used-at timestamp for verification.
 *
 * Returns `null` when the user has no recovery code set (legacy
 * accounts predating PR-a) or when the user does not exist / is
 * soft-deleted.
 * @param userId - User UUID whose recovery code to fetch
 * @returns `{ hash, usedAt }` when a code is set, or null when none / user missing
 */
export async function getRecoveryCode(
  userId: string,
): Promise<{ hash: string; usedAt: Date | null } | null> {
  const rows = await db
    .select({
      recoveryCodeHash: users.recoveryCodeHash,
      recoveryCodeUsedAt: users.recoveryCodeUsedAt,
    })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.recoveryCodeHash) return null;
  return { hash: row.recoveryCodeHash, usedAt: row.recoveryCodeUsedAt };
}

/**
 * Mark the user's recovery code as consumed (single-use).
 *
 * Caller must immediately set a fresh code via `setRecoveryCode` and
 * return the plaintext to the user — losing access to the new code
 * after a reset would lock them out for future resets.
 * @param userId - User UUID whose recovery code to mark consumed
 */
export async function markRecoveryCodeUsed(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ recoveryCodeUsedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
}
