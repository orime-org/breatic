// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upstream clone repository — data access for `studio_upstream_clones`
 * (#2156): the voice, vocal and element ids a studio has had cloned, keyed by
 * the source they came from. Read and written only by the worker.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, studioUpstreamClones } from "@breatic/core";

/** What was cloned. */
export type UpstreamCloneKind = "voice" | "vocal" | "element";

/**
 * The live upstream id cloned from a source.
 * @param studioId - The studio.
 * @param kind - What was cloned.
 * @param sourceKey - The source asset's sha256 (an element adds `:name`).
 * @returns The upstream id, or null when this source has none.
 */
export async function findClone(
  studioId: string,
  kind: UpstreamCloneKind,
  sourceKey: string,
): Promise<string | null> {
  const [row] = await db
    .select({ upstreamId: studioUpstreamClones.upstreamId })
    .from(studioUpstreamClones)
    .where(
      and(
        eq(studioUpstreamClones.studioId, studioId),
        eq(studioUpstreamClones.kind, kind),
        eq(studioUpstreamClones.sourceKey, sourceKey),
        isNull(studioUpstreamClones.deletedAt),
      ),
    )
    .limit(1);
  return row?.upstreamId ?? null;
}

/**
 * Record a fresh clone. When another run recorded one for the same source
 * first, that one stays and this call writes nothing.
 * @param studioId - The studio.
 * @param kind - What was cloned.
 * @param sourceKey - The source asset's sha256 (an element adds `:name`).
 * @param upstreamId - The id the upstream answered.
 * @returns True when this call recorded it.
 */
export async function recordClone(
  studioId: string,
  kind: UpstreamCloneKind,
  sourceKey: string,
  upstreamId: string,
): Promise<boolean> {
  const rows = await db
    .insert(studioUpstreamClones)
    .values({ studioId, kind, sourceKey, upstreamId })
    .onConflictDoNothing({
      target: [studioUpstreamClones.studioId, studioUpstreamClones.kind, studioUpstreamClones.sourceKey],
      where: isNull(studioUpstreamClones.deletedAt),
    })
    .returning({ id: studioUpstreamClones.id });
  return rows.length > 0;
}

/**
 * Soft-delete a clone the upstream no longer recognises, so the next run on
 * that source clones it again.
 * @param studioId - The studio.
 * @param kind - What was cloned.
 * @param upstreamId - The id the upstream refused.
 * @returns Nothing.
 */
export async function retireClone(studioId: string, kind: UpstreamCloneKind, upstreamId: string): Promise<void> {
  await db
    .update(studioUpstreamClones)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(studioUpstreamClones.studioId, studioId),
        eq(studioUpstreamClones.kind, kind),
        eq(studioUpstreamClones.upstreamId, upstreamId),
        isNull(studioUpstreamClones.deletedAt),
      ),
    );
}
