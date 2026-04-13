/**
 * User repository — data access for the users table.
 *
 * Handles CRUD operations and atomic credit modifications.
 */

import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import type { UserEntity } from "@breatic/shared";

/** Convert a Drizzle row to a UserEntity (strips hashed_password). */
function toEntity(row: typeof users.$inferSelect): UserEntity {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatarUrl,
    credits: row.credits,
    membershipType: row.membershipType,
    membershipExpiresAt: row.membershipExpiresAt,
    emailVerified: row.emailVerified,
    googleId: row.googleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Find a user by ID (excludes soft-deleted). */
export async function getUserById(userId: string): Promise<UserEntity | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** Find a user by email (excludes soft-deleted). */
export async function getUserByEmail(email: string): Promise<UserEntity | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** Find a user by Google ID (excludes soft-deleted). */
export async function getUserByGoogleId(googleId: string): Promise<UserEntity | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.googleId, googleId), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** Get the hashed password for login verification. */
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
 *
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

/** Update user profile fields. */
export async function updateUser(
  userId: string,
  data: Partial<Pick<typeof users.$inferInsert, "username" | "avatarUrl" | "emailVerified" | "membershipType" | "membershipExpiresAt" | "googleId">>,
): Promise<UserEntity | null> {
  const rows = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Atomically deduct credits. Fails if insufficient balance.
 *
 * @returns `true` if deduction succeeded, `false` if insufficient credits
 */
export async function deductCredits(userId: string, amount: number): Promise<boolean> {
  const result = await db.execute(
    sql`UPDATE users SET credits = credits - ${amount}, updated_at = NOW()
        WHERE id = ${userId} AND credits >= ${amount} AND deleted_at IS NULL
        RETURNING id`,
  );
  return (result as unknown[]).length > 0;
}

/**
 * Atomically add credits to a user's balance.
 *
 * @returns The new credit balance
 */
export async function addCredits(userId: string, amount: number): Promise<number> {
  const result = await db.execute(
    sql`UPDATE users SET credits = credits + ${amount}, updated_at = NOW()
        WHERE id = ${userId} AND deleted_at IS NULL
        RETURNING credits`,
  );
  const rows = result as unknown as Array<{ credits: number }>;
  return rows[0]?.credits ?? 0;
}

/**
 * Get current credit balance.
 *
 * @returns Credit balance or 0 if user not found
 */
export async function getCredits(userId: string): Promise<number> {
  const rows = await db
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.credits ?? 0;
}
