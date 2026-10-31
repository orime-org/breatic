// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { budgetDeadlineFrom, env, getAgentConfig, getStorageAdapter, logger } from "@breatic/core";
import { assetRepo, createAgentPicturePreparer, readerUrlSchema, SaveRefused } from "@breatic/domain";
import type { AgentPictureSource, PrepareAgentPictures } from "@breatic/domain";
import { agentPictureKeyFor, attachmentTitle, readStoredMediaAtIngest } from "@breatic/shared";
import type { ChatAttachedChip } from "@breatic/shared";
import { saveToStorageFor } from "@server/agent/save-to-storage.js";

/** The project and Studio whose registered assets this turn may read. */
interface PictureIdentity {
  projectId: string;
  userId: string;
  studioId: string;
  allowedExternal?: ReadonlySet<string>;
}

/**
 * Bind source authorization and edge JPEG creation to one turn's identity.
 * @param who - The reader, project and owning Studio.
 * @returns The turn-local bounded preparation callback.
 * @throws {unknown} Invalid runtime configuration.
 */
export function picturePreparerFor(who: PictureIdentity): PrepareAgentPictures {
  const config = getAgentConfig();
  const save = saveToStorageFor(who);
  return createAgentPicturePreparer({
    spec: { version: 1, longEdge: config.agent_picture_long_edge, quality: config.agent_picture_quality },
    concurrency: config.agent_picture_concurrency,
    resolveSource: async (source, signal) => {
      try {
        signal?.throwIfAborted();
        const storage = await getStorageAdapter();
        let key = storage.keyFromUrl(source.sourceUrl);
        if (key === null) {
          if (who.allowedExternal !== undefined && !who.allowedExternal.has(source.sourceUrl)) {
            return { status: "unavailable", reason: "The source was not provided to this turn." };
          }
          if (!readerUrlSchema.safeParse(source.sourceUrl).success) {
            return { status: "unavailable", reason: "The source must be a valid HTTPS URL within the source URL limit." };
          }
          const saved = await save(source.sourceUrl, signal);
          signal?.throwIfAborted();
          key = storage.keyFromUrl(saved.url);
          if (key === null) return { status: "unavailable", reason: "The source was not registered in storage." };
        }
        const row = await assetRepo.findLiveByKeyInStudio(who.studioId, key);
        signal?.throwIfAborted();
        if (row === null) return { status: "unavailable", reason: "The source is not a live asset in this Studio." };
        if (!row.mimeType.startsWith("image/")) return { status: "unavailable", reason: "The source is not an image." };
        return { storageKey: row.storageKey, contentType: row.mimeType };
      } catch (err) {
        if (signal?.aborted === true) throw err;
        if (err instanceof SaveRefused) return { status: "unavailable", reason: err.message };
        logger.error({ err, projectId: who.projectId, userId: who.userId, studioId: who.studioId, sourceUrl: source.sourceUrl }, "agent_picture_source_failed");
        throw err;
      }
    },
    readPicture: async (source, spec, signal) => {
      try {
        signal?.throwIfAborted();
        const result = await readStoredMediaAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
          ...source, agentPicture: spec, deadlineAt: budgetDeadlineFrom(Date.now()),
        }, signal);
        signal?.throwIfAborted();
        const picture = result.agentPicture;
        if (picture === undefined || (picture.outcome !== "generated" && picture.outcome !== "existing")) {
          return { status: "unavailable", reason: "A JPEG representation could not be prepared." };
        }
        const storage = await getStorageAdapter();
        signal?.throwIfAborted();
        return { url: storage.publicUrl(agentPictureKeyFor(source.storageKey, spec)), sizeBytes: picture.sizeBytes, mediaType: picture.mediaType };
      } catch (err) {
        if (signal?.aborted === true) throw err;
        logger.error({ err, projectId: who.projectId, userId: who.userId, studioId: who.studioId, storageKey: source.storageKey }, "agent_picture_prepare_failed");
        throw err;
      }
    },
  });
}

/**
 * Read only images explicitly attached as files or picked canvas nodes.
 * @param chips - The actual attachments of the current reader message.
 * @returns Sources in attachment and node order, retaining duplicate occurrences.
 * @throws {never} Never.
 */
export function pictureSourcesForTurn(chips: readonly ChatAttachedChip[]): AgentPictureSource[] {
  return chips.flatMap((chip, index) => {
    const label = `Attachment ${String(index + 1)}: ${attachmentTitle(chip)}`;
    if (chip.type === "image" && typeof chip.data_snapshot.url === "string") return [{ label, sourceUrl: chip.data_snapshot.url }];
    if (chip.type !== "canvas" || !Array.isArray(chip.data_snapshot.nodes)) return [];
    return chip.data_snapshot.nodes.flatMap((value: unknown) => {
      if (value === null || typeof value !== "object") return [];
      const node = value as { id?: unknown; type?: unknown; data?: { content?: unknown; name?: unknown } };
      return node.type === "image" && typeof node.data?.content === "string" && node.data.content !== ""
        ? [{ label: `${label}; node ${typeof node.id === "string" ? node.id : "unknown"}: ${typeof node.data.name === "string" ? node.data.name : "image"}`, sourceUrl: node.data.content }]
        : [];
    });
  });
}
