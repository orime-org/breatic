// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Upstream clone repository — data access for `studio_upstream_clones`
 * (#2156): the voice, vocal and element ids a studio has had cloned on each
 * upstream, keyed by the source they came from. Read and written only by the
 * worker, which hands them to provider and writes back what each answer made
 * or retired (inner#1743). A clone lives on the upstream account whose key
 * made it, so each is kept per key owner (inner#1953): `deployment` for our
 * keys, the account's id for an account's key, and neither reuses the other's.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, studioUpstreamClones } from "@breatic/core";

/** Whose upstream account holds a clone: `deployment` for our keys, else the account's id. */
export type CloneKeyOwner = "deployment" | (string & {});

/** What was cloned. */
export type UpstreamCloneKind = "voice" | "vocal" | "element";

/** One live clone, as provider takes it. */
export interface LiveClone {
  upstream: string;
  kind: UpstreamCloneKind;
  sourceKey: string;
  upstreamId: string;
}

/**
 * The live clones of these sources on every upstream: those keyed by a source's sha256, and its elements (keyed by
 * the sha256 and a suffix after a colon).
 * @param studioId - The studio.
 * @param sha256s - The sources' sha256s.
 * @param keyOwner - Whose keys the run uses; only that owner's clones are answered.
 * @returns The clones; none for no sources.
 */
export async function liveClonesFor(studioId: string, sha256s: readonly string[], keyOwner: CloneKeyOwner): Promise<LiveClone[]> {
  if (sha256s.length === 0) return [];
  const rows = await db
    .select({
      upstream: studioUpstreamClones.upstream,
      kind: studioUpstreamClones.kind,
      sourceKey: studioUpstreamClones.sourceKey,
      upstreamId: studioUpstreamClones.upstreamId,
    })
    .from(studioUpstreamClones)
    .where(
      and(
        eq(studioUpstreamClones.studioId, studioId),
        eq(studioUpstreamClones.keyOwner, keyOwner),
        isNull(studioUpstreamClones.deletedAt),
        or(
          inArray(studioUpstreamClones.sourceKey, [...sha256s]),
          ...sha256s.map((sha) => sql`starts_with(${studioUpstreamClones.sourceKey}, ${`${sha}:`})`),
        ),
      ),
    );
  return rows.map((row) => ({ ...row, kind: row.kind as UpstreamCloneKind }));
}

/**
 * Record a fresh clone. When another run recorded one for the same source, upstream and key owner first, that one
 * stays and this call writes nothing.
 * @param studioId - The studio.
 * @param upstream - The upstream that made it.
 * @param kind - What was cloned.
 * @param sourceKey - The source asset's sha256 (an element adds its suffix after a colon).
 * @param upstreamId - The id the upstream answered.
 * @param keyOwner - Whose keys made it.
 * @returns True when this call recorded it.
 */
export async function recordClone(
  studioId: string,
  upstream: string,
  kind: UpstreamCloneKind,
  sourceKey: string,
  upstreamId: string,
  keyOwner: CloneKeyOwner,
): Promise<boolean> {
  const rows = await db
    .insert(studioUpstreamClones)
    .values({ studioId, upstream, kind, sourceKey, upstreamId, keyOwner })
    .onConflictDoNothing({
      target: [
        studioUpstreamClones.studioId,
        studioUpstreamClones.upstream,
        studioUpstreamClones.kind,
        studioUpstreamClones.sourceKey,
        studioUpstreamClones.keyOwner,
      ],
      where: isNull(studioUpstreamClones.deletedAt),
    })
    .returning({ id: studioUpstreamClones.id });
  return rows.length > 0;
}

/**
 * Soft-delete a clone the upstream no longer recognises, so the next run on that source clones it again there.
 * @param studioId - The studio.
 * @param upstream - The upstream that refused it.
 * @param kind - What was cloned.
 * @param upstreamId - The id the upstream refused.
 * @param keyOwner - Whose keys the refused clone was made with.
 * @returns Nothing.
 */
export async function retireClone(
  studioId: string,
  upstream: string,
  kind: UpstreamCloneKind,
  upstreamId: string,
  keyOwner: CloneKeyOwner,
): Promise<void> {
  await db
    .update(studioUpstreamClones)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(studioUpstreamClones.studioId, studioId),
        eq(studioUpstreamClones.upstream, upstream),
        eq(studioUpstreamClones.kind, kind),
        eq(studioUpstreamClones.upstreamId, upstreamId),
        eq(studioUpstreamClones.keyOwner, keyOwner),
        isNull(studioUpstreamClones.deletedAt),
      ),
    );
}
