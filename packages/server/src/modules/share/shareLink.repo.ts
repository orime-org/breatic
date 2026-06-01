/**
 * Share link repository — `share_links` table CRUD.
 *
 * Two link variants discriminated by an explicit `kind` column
 * ('email' vs 'link'). The DB CHECK constraints guarantee
 * `kind = 'email' ⇔ boundEmail IS NOT NULL`, so application code
 * branches on `kind` alone and never on `boundEmail` nullness:
 *
 *   - kind = 'email': single-use, bound to the recipient's email,
 *     expires in 7 days. `markConsumed` flips `consumed_at` after
 *     the bound user logs in and accepts.
 *   - kind = 'link':  multi-use, no expiry, lives until the owner
 *     soft-deletes. `markConsumed` is NOT called for these —
 *     the service layer skips it.
 *
 * Token uniqueness is enforced by the SQL UNIQUE constraint on
 * `token`; the service catches 23505 and rethrows as Conflict (the
 * caller can retry with a freshly generated token).
 *
 * Design: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 3.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { shareLinks } from "@breatic/core";
import type { DbTx } from "@server/modules/conversation/conversation.repo.js";

/** Discriminator for the two share-link modes. */
export type ShareLinkKind = "email" | "link";

export interface ShareLink {
  id: string;
  projectId: string;
  createdByUserId: string;
  token: string;
  role: string;
  /**
   * Mode discriminator. Application code MUST branch on this, not on
   * `boundEmail` nullness — the DB CHECK constraints keep the two
   * fields in sync, but `kind` is the single source of truth.
   */
  kind: ShareLinkKind;
  /**
   * Recipient email. Non-null iff `kind === 'email'`. The DB CHECK
   * `share_links_kind_bound_email_check` enforces this.
   */
  boundEmail: string | null;
  consumedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Map a raw `share_links` table row to a `ShareLink` domain object.
 * @param row - Raw row selected from the `share_links` table
 * @returns The mapped share link
 */
function toEntity(row: typeof shareLinks.$inferSelect): ShareLink {
  return {
    id: row.id,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    token: row.token,
    role: row.role,
    kind: row.kind as ShareLinkKind,
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
 * (32-byte base64url is the recommended format) and must satisfy the
 * `kind` / `boundEmail` pairing — kind='email' requires boundEmail
 * non-null, kind='link' requires boundEmail null. The DB CHECK will
 * reject mismatches, but the service layer should already enforce.
 * @param input - Share link fields to insert
 * @param input.projectId - Project the link grants access to
 * @param input.createdByUserId - User who created the link
 * @param input.token - Pre-generated unique token (base64url)
 * @param input.role - Role granted on consume ('edit' or 'view')
 * @param input.kind - Link mode ('email' single-use, or 'link' multi-use)
 * @param input.boundEmail - Recipient email; non-null iff `kind === 'email'`
 * @param input.expiresAt - Expiry timestamp; null for non-expiring 'link' kind
 * @returns The inserted share link
 * @throws {Error} if the insert returns no row
 */
export async function create(input: {
  projectId: string;
  createdByUserId: string;
  token: string;
  role: string;
  kind: ShareLinkKind;
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
      kind: input.kind,
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
 * @param id - Share link UUID
 * @returns The share link (revoked or not), or null if no row matches
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
 * @param token - Share link token from the URL
 * @returns The active (non-revoked) share link, or null if none matches
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

/**
 * List active links for a project, newest first.
 * @param projectId - Project UUID
 * @returns The project's active (non-revoked) share links, newest first
 */
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
 * Caller MUST only invoke this for email-invite links (kind='email').
 * Multi-use 'link' rows are not single-shot and should not have
 * their consumed_at touched. The WHERE clause includes the kind
 * check as belt-and-suspenders.
 * @param id - Share link UUID (must be a kind='email' link)
 * @param tx - Optional transaction handle to run the update within
 * @returns True if this call marked the link consumed; false if it was
 *   already consumed, revoked, or not an email-invite link
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
        eq(shareLinks.kind, "email"),
        isNull(shareLinks.consumedAt),
        isNull(shareLinks.deletedAt),
      ),
    )
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}

/**
 * Soft-delete a share link (owner-initiated revoke).
 * @param id - Share link UUID
 * @returns True if a row was revoked; false if it was already revoked or absent
 */
export async function softDelete(id: string): Promise<boolean> {
  const rows = await db
    .update(shareLinks)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(shareLinks.id, id), isNull(shareLinks.deletedAt)))
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}
