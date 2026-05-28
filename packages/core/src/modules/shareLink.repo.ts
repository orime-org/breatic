/**
 * Share link repository — `share_links` table CRUD.
 *
 * Two link variants discriminated by `boundEmail` (NULL vs not):
 *   - Email-invite (boundEmail NOT NULL): single-use, bound to the
 *     recipient's email, expires in 7 days. `markConsumed` flips
 *     `consumed_at` after the bound user logs in and accepts.
 *   - Generate (boundEmail NULL): multi-use, no expiry, lives until
 *     the owner soft-deletes. `markConsumed` is NOT called for these
 *     — the service layer skips it.
 *
 * Token uniqueness is enforced by the SQL UNIQUE constraint on
 * `token`; the service catches 23505 and rethrows as Conflict (the
 * caller can retry with a freshly generated token).
 *
 * Design: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 3.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { shareLinks } from "../db/schema.js";
import type { DbTx } from "./conversation.repo.js";

export interface ShareLink {
  id: string;
  projectId: string;
  createdByUserId: string;
  token: string;
  role: string;
  /**
   * Email address this link is bound to, if any. NULL = multi-use
   * Generate link (anyone with the URL can join). NOT NULL =
   * single-use email-invite (only the user whose email matches
   * can consume).
   */
  boundEmail: string | null;
  consumedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function toEntity(row: typeof shareLinks.$inferSelect): ShareLink {
  return {
    id: row.id,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    token: row.token,
    role: row.role,
    boundEmail: row.boundEmail,
    consumedAt: row.consumedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Insert a new share link. Caller passes a pre-generated token
 * (32-byte base64url is the recommended format).
 *
 * Email-invite caller: pass `boundEmail` + `expiresAt` (now + 7d).
 * Generate caller: pass `boundEmail = null` + `expiresAt = null`.
 */
export async function create(input: {
  projectId: string;
  createdByUserId: string;
  token: string;
  role: string;
  boundEmail: string | null;
  expiresAt: Date | null;
}): Promise<ShareLink> {
  const rows = await db
    .insert(shareLinks)
    .values({
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      token: input.token,
      role: input.role,
      boundEmail: input.boundEmail,
      expiresAt: input.expiresAt,
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("shareLinkRepo.create: insert returned no row");
  }
  return toEntity(row);
}

/**
 * Find a share link by id (no soft-delete filter so the service can
 * verify the row exists even if it's been revoked).
 */
export async function findById(id: string): Promise<ShareLink | null> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.id, id))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Find an active share link by token (soft-delete filtered).
 *
 * Returns null for revoked links so consume can't accidentally
 * resurrect them. Single-use vs permanent + expires_at + consumed_at
 * checks happen in the service layer.
 */
export async function findActiveByToken(token: string): Promise<ShareLink | null> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(
      and(eq(shareLinks.token, token), isNull(shareLinks.deletedAt)),
    )
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** List active links for a project, newest first. */
export async function listByProject(projectId: string): Promise<ShareLink[]> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.projectId, projectId),
        isNull(shareLinks.deletedAt),
      ),
    )
    .orderBy(desc(shareLinks.createdAt));
  return rows.map(toEntity);
}

/**
 * Atomically mark an email-invite link as consumed (set consumed_at).
 *
 * Returns `false` if the row was already consumed by a concurrent
 * caller — the WHERE clause filters out rows where consumed_at is
 * non-null. The service layer rejects the consume in that case.
 *
 * Caller MUST only invoke this for email-invite links (boundEmail
 * NOT NULL). Generate links (boundEmail NULL) are multi-use and
 * should not have their consumed_at touched.
 */
export async function markConsumed(
  id: string,
  tx?: DbTx,
): Promise<boolean> {
  const handle = tx ?? db;
  const rows = await handle
    .update(shareLinks)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(shareLinks.id, id),
        sql`${shareLinks.boundEmail} IS NOT NULL`,
        isNull(shareLinks.consumedAt),
        isNull(shareLinks.deletedAt),
      ),
    )
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}

/** Soft-delete a share link (owner-initiated revoke). */
export async function softDelete(id: string): Promise<boolean> {
  const rows = await db
    .update(shareLinks)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(shareLinks.id, id), isNull(shareLinks.deletedAt)))
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}
