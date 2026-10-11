// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the registration behind a material address says (inner#1315).
 *
 * An agent's proposal hands the reader's material over by address. Whether an
 * address is ours, belongs to this studio and is still live, and what numbers
 * a node holding it lands with, are all answered by the ledger row registered
 * under the key that address names.
 */

import { getStorageAdapter } from "@breatic/core";
import type { NodeMediaFields, StudioAssetEntity } from "@breatic/shared";
import { findCoverOf, findLiveByKeyInStudio } from "@domain/asset/asset.repo.js";

/** What the registration behind one material address says. */
export interface MaterialFacts {
  /** What the ledger judged the stored bytes to be. */
  kind: StudioAssetEntity["kind"];
  /** The numbers a node holding it lands with. */
  media: NodeMediaFields;
}

/**
 * The registration behind each material address. An address with no entry is
 * not in our storage at all; one marked `"missing"` is in our storage but has
 * no live registration in this studio, which is what a mistyped copy of a
 * real address looks like.
 */
export type MaterialTable = ReadonlyMap<string, MaterialFacts | "missing">;

/**
 * Read the registration behind each address, for one studio.
 *
 * An address that is not ours is left out without asking the ledger; one whose
 * key has no live row in this studio is marked missing. A video carries its cover,
 * the way an upload settles one onto its node.
 * @param studioId - The studio the material must belong to.
 * @param urls - The addresses a proposal names.
 * @returns What each address that is this studio's holds.
 * @throws {unknown} When the ledger or the storage configuration cannot be read.
 */
export async function materialFacts(studioId: string, urls: readonly string[]): Promise<MaterialTable> {
  const storage = await getStorageAdapter();
  const table = new Map<string, MaterialFacts | "missing">();
  for (const url of new Set(urls)) {
    const key = storage.keyFromUrl(url);
    if (key === null) continue;
    const row = await findLiveByKeyInStudio(studioId, key);
    if (row === null) {
      table.set(url, "missing");
      continue;
    }
    const cover = row.kind === "video" ? await findCoverOf(row.id) : null;
    table.set(url, {
      kind: row.kind,
      media: {
        coverUrl: cover?.fileUrl ?? null,
        width: row.width,
        height: row.height,
        duration: row.durationSeconds,
        mimeType: row.mimeType,
        size: row.sizeBytes,
      },
    });
  }
  return table;
}
