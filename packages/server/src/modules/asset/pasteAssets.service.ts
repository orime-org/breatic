// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A paste into a canvas counts as an upload into the Studio it lands in
 * (inner#1349, design 5.4).
 *
 * No bytes move. Every address the copy names is looked up by its storage key;
 * an address the target Studio already holds by content hash is used as it
 * is, and one it lacks is registered against the same key, counted toward its
 * storage. A video is handled with its cover, the way an upload files them:
 * cover first, then the video pointing at it. Each copy then gets one history
 * row from its own data, its addresses taken from this answer rather than the
 * request.
 */

import { getStorageAdapter, logger } from "@breatic/core";
import type { PasteHistoryItem, PastePair, StudioAssetEntity } from "@breatic/shared";
import { assetRepo, assetService, ingestReportService, nodeHistoryService } from "@breatic/domain";

import { assertStudioStorageAllowance } from "@server/modules/asset/storageQuota.service.js";

/** What a paste asks for. */
export interface PasteInput {
  projectId: string;
  userId: string;
  urls: string[];
  pairs: PastePair[];
  history: PasteHistoryItem[];
}

/** One address the target Studio does not hold yet, and how it is filed. */
interface Miss {
  address: string;
  source: StudioAssetEntity;
  as: "upload" | "cover";
}

/**
 * Register a paste's resources in the target Studio and write each copy's
 * history.
 * @param input - Where the paste lands, who pastes, and what the copy names.
 * @returns Old address → address in the target Studio; a cover that could
 *   not be filed maps to null. Addresses no ledger knows are left out.
 * @throws {AppError} 507 when something must be registered and the target
 *   Studio has no storage left; nothing is written then.
 */
export async function pasteAssets(input: PasteInput): Promise<Record<string, string | null>> {
  const studioId = await assetService.resolveOwnerStudioId(input.projectId);
  const storage = await getStorageAdapter();
  const map: Record<string, string | null> = {};

  /**
   * The live row an address names, from any Studio.
   * @param address - A storage address.
   * @returns The row, or null.
   */
  const sourceOf = async (address: string): Promise<StudioAssetEntity | null> => {
    const key = storage.keyFromUrl(address);
    return key === null ? null : assetRepo.findLiveByStorageKey(key);
  };

  // Read everything first; nothing is written until the storage gate passed.
  const misses: Miss[] = [];
  // The cover row in the target Studio for each cover address that has one.
  const coverRows = new Map<string, StudioAssetEntity>();
  // Each video's source row and its hit in the target Studio, if any.
  const videos: Array<{ pair: PastePair; video: StudioAssetEntity; hit: StudioAssetEntity | null }> = [];
  for (const pair of input.pairs) {
    const video = await sourceOf(pair.url);
    if (video === null) continue;
    const cover = await sourceOf(pair.cover);
    const hit = await assetRepo.findByStudioAndHash(studioId, video.contentHash);
    videos.push({ pair, video, hit });
    if (hit === null) misses.push({ address: pair.url, source: video, as: "upload" });
    else map[pair.url] = hit.fileUrl;
    if (cover === null) continue;
    const standing = hit === null ? null : await assetRepo.findCoverOf(hit.id);
    if (standing !== null) {
      map[pair.cover] = standing.fileUrl;
      continue;
    }
    const coverHit = await assetRepo.findByStudioAndHash(studioId, cover.contentHash);
    if (coverHit === null) {
      misses.push({ address: pair.cover, source: cover, as: "cover" });
      continue;
    }
    map[pair.cover] = coverHit.fileUrl;
    coverRows.set(pair.cover, coverHit);
  }
  for (const address of new Set(input.urls)) {
    if (address in map || misses.some((miss) => miss.address === address)) continue;
    const source = await sourceOf(address);
    if (source === null) continue;
    const hit = await assetRepo.findByStudioAndHash(studioId, source.contentHash);
    if (hit === null) misses.push({ address, source, as: "upload" });
    else map[address] = hit.fileUrl;
  }

  if (misses.length > 0) await assertStudioStorageAllowance(studioId, "upload");

  /**
   * File one missed address in the target Studio.
   * @param miss - The address and its source row.
   * @param coverAssetId - The cover a video points at, filed in the same insert.
   * @returns The row in the target Studio.
   */
  const file = async (miss: Miss, coverAssetId?: string): Promise<StudioAssetEntity> => {
    const { asset } = await assetRepo.registerWithDedup({
      studioId,
      producedByUserId: input.userId,
      contentHash: miss.source.contentHash,
      storageKey: miss.source.storageKey,
      fileUrl: storage.publicUrl(miss.source.storageKey),
      sizeBytes: miss.source.sizeBytes,
      mimeType: miss.source.mimeType,
      kind: miss.source.kind,
      source: miss.as,
      width: miss.source.width,
      height: miss.source.height,
      durationSeconds: miss.source.durationSeconds,
      ...(coverAssetId !== undefined && { coverAssetId }),
    });
    map[miss.address] = asset.fileUrl;
    return asset;
  };

  // Covers first, so a video can point at its cover in its own insert. A cover
  // that cannot be filed does not fail the paste: the video goes in without a
  // poster, as an upload's does.
  for (const miss of misses.filter((m) => m.as === "cover")) {
    try {
      coverRows.set(miss.address, await file(miss));
    } catch (err) {
      logger.error({ err, studioId, address: miss.address }, "paste_cover_register_failed");
      map[miss.address] = null;
    }
  }
  for (const { pair, video, hit } of videos) {
    const cover = coverRows.get(pair.cover);
    if (hit === null) {
      await file({ address: pair.url, source: video, as: "upload" }, cover?.id);
      continue;
    }
    // A video the Studio already held: keep the cover it shows, or give it
    // this one when it has none.
    if (cover === undefined) continue;
    const settled = await ingestReportService.settleDedupedCover(hit, { id: cover.id, url: cover.fileUrl });
    if (settled.failed) {
      logger.error({ studioId, videoAssetId: hit.id }, "paste_cover_link_failed");
      map[pair.cover] = null;
    }
  }
  for (const miss of misses.filter((m) => m.as === "upload" && !(m.address in map))) {
    await file(miss);
  }

  for (const item of input.history) {
    if (item.kind === "text") {
      if (item.content.trim().length === 0) continue;
      await nodeHistoryService.recordSnapshot({
        projectId: input.projectId,
        nodeId: item.node_id,
        userId: input.userId,
        content: item.content,
      });
      continue;
    }
    const content = map[item.content];
    if (content === undefined || content === null) continue;
    const thumbnail = item.coverUrl === undefined ? undefined : map[item.coverUrl];
    await nodeHistoryService.recordUpload({
      projectId: input.projectId,
      nodeId: item.node_id,
      userId: input.userId,
      content,
      ...(typeof thumbnail === "string" && { thumbnailUrl: thumbnail }),
      media: {
        width: item.width ?? null,
        height: item.height ?? null,
        duration: item.duration ?? null,
        mimeType: item.mimeType ?? null,
        size: item.size ?? null,
      },
    });
  }
  return map;
}

