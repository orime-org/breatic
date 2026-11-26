// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A paste into a canvas counts as an upload into the Studio it lands in
 * (inner#1349, design 5.4).
 *
 * No bytes move. Every address the copy names is looked up by its storage key;
 * an address the target Studio already holds by content hash is used as it
 * is, and one it lacks is registered against the same key, counted toward its
 * storage. A video is handled with its cover, the way an upload files them:
 * cover first, then the video pointing at it; a video named without its cover
 * (a document block holds only the video's address) brings the cover the
 * ledger knows for its key. Each copy then gets one history row from its own
 * data, its addresses taken from this answer rather than the request, and
 * what the copy lacks taken from the target Studio's ledger. Every main asset
 * the paste maps (an address in `urls`, a pair's video) is related to the
 * Project in the same request, the way an upload relates what it registers;
 * a pair's cover is not (inner#2171 design §5.1).
 */

import { accountActivityRepo, getStorageAdapter, logger, projectAssetReferenceService } from "@breatic/core";
import { assetNameFromUrl, type CanvasPasteAnswer, type NodeMediaFields, type PasteHistoryItem, type PastePair, type StudioAssetEntity } from "@breatic/shared";
import { assetRepo, assetService, ingestReportService, materialFacts, nodeHistoryService } from "@breatic/domain";

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
 * @returns Old address → address in the target Studio (a cover that could
 *   not be filed maps to null; addresses no ledger knows are left out), and
 *   what the target Studio's ledger holds for each address it maps to.
 * @throws {AppError} 507 when something must be registered and the target
 *   Studio has no storage left; nothing is written then.
 */
export async function pasteAssets(input: PasteInput): Promise<CanvasPasteAnswer> {
  const studioId = await assetService.resolveOwnerStudioId(input.projectId);
  const storage = await getStorageAdapter();
  const map: Record<string, string | null> = {};
  // The target Studio's row behind each mapped address.
  const rowIds: Record<string, string> = {};

  // Every key the paste names is read from the ledger in one answer.
  const addresses = new Set([...input.urls, ...input.pairs.flatMap((pair) => [pair.url, pair.cover])]);
  const found = await assetRepo.findByStorageKeys(
    [...addresses].map((address) => storage.keyFromUrl(address)).filter((key) => key !== null),
  );

  // Cover rows found under a video's key, by the cover's own key.
  const covers = new Map<string, StudioAssetEntity>();

  /**
   * The live row an address names, from any Studio.
   * @param address - A storage address.
   * @returns The row, or null.
   */
  const sourceOf = (address: string): StudioAssetEntity | null => {
    const key = storage.keyFromUrl(address);
    if (key === null) return null;
    return found.get(key)?.asset ?? covers.get(key) ?? null;
  };

  // Read everything first; nothing is written until the storage gate passed.
  const misses: Miss[] = [];
  // The cover row in the target Studio for each cover address that has one.
  const coverRows = new Map<string, StudioAssetEntity>();
  // Each video's source row and its hit in the target Studio, if any.
  const videos: Array<{ pair: PastePair; video: StudioAssetEntity; hit: StudioAssetEntity | null }> = [];
  const pairs = [...input.pairs];
  const paired = new Set(pairs.flatMap((pair) => [pair.url, pair.cover]));
  for (const address of new Set(input.urls)) {
    const key = paired.has(address) ? null : storage.keyFromUrl(address);
    const cover = key === null ? null : (found.get(key)?.cover ?? null);
    if (cover !== null) {
      pairs.push({ url: address, cover: cover.fileUrl });
      covers.set(cover.storageKey, cover);
    }
  }
  for (const pair of pairs) {
    const video = sourceOf(pair.url);
    if (video === null) continue;
    const cover = sourceOf(pair.cover);
    const hit = await assetRepo.findByStudioAndHash(studioId, video.contentHash);
    videos.push({ pair, video, hit });
    if (hit === null) misses.push({ address: pair.url, source: video, as: "upload" });
    else {
      map[pair.url] = hit.fileUrl;
      rowIds[pair.url] = hit.id;
    }
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
    const source = sourceOf(address);
    if (source === null) continue;
    const hit = await assetRepo.findByStudioAndHash(studioId, source.contentHash);
    if (hit === null) misses.push({ address, source, as: "upload" });
    else {
      map[address] = hit.fileUrl;
      rowIds[address] = hit.id;
    }
  }

  if (misses.length > 0) await assertStudioStorageAllowance(studioId, "upload");
  await accountActivityRepo.recordActivity({ userId: input.userId, projectId: input.projectId, kind: "project_action" });

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
    rowIds[miss.address] = asset.id;
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

  // The main assets join this Project now; covers show with their videos.
  const main = [...new Set([...input.urls, ...pairs.map((pair) => pair.url)])].filter((address) => rowIds[address] !== undefined);
  await projectAssetReferenceService.recordProjectAssetReferences({
    projectId: input.projectId,
    assetIds: main.map((address) => rowIds[address]!),
    displayNames: Object.fromEntries(main.flatMap((address) => {
      const name = assetNameFromUrl(address);
      return name === null ? [] : [[rowIds[address]!, name]];
    })),
  });

  // What the target Studio's ledger holds for every address the copy now names.
  const media: Record<string, NodeMediaFields> = {};
  const mapped = Object.values(map).filter((address): address is string => address !== null);
  for (const [address, facts] of await materialFacts(studioId, mapped)) {
    if (facts !== "missing") media[address] = facts.media;
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
    const held = media[content];
    const thumbnail = item.coverUrl === undefined ? held?.coverUrl : map[item.coverUrl];
    await nodeHistoryService.recordUpload({
      projectId: input.projectId,
      nodeId: item.node_id,
      userId: input.userId,
      content,
      ...(typeof thumbnail === "string" && { thumbnailUrl: thumbnail }),
      media: {
        width: item.width ?? held?.width ?? null,
        height: item.height ?? held?.height ?? null,
        duration: item.duration ?? held?.duration ?? null,
        mimeType: item.mimeType ?? held?.mimeType ?? null,
        size: item.size ?? held?.size ?? null,
      },
    });
  }
  return { map, media };
}


