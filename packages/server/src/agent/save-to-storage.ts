// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent's save, as one turn runs it (inner#1315).
 *
 * The same gates the canvas paste of a link goes through, in its order --
 * rate, access, storage -- and then the transfer, in this request rather than
 * through the paste's queue: the model is waiting on the answer. Each refusal
 * is handed to the tool as the kind it tells the model about. The rate-limit
 * and link refusals are logged here, where the turn's project and reader are
 * known; the storage gate logs its own, and an access refusal is not logged.
 */

import { AppError, checkRateLimit, getRedis, logger } from "@breatic/core";
import {
  backendUploadService,
  isReaderLinkFault,
  SaveRefused,
  urlIngestFailureLevel,
  type SaveToStorage,
} from "@breatic/domain";
import { getRateLimit } from "@server/config/rate-limits.js";
import { noteIngestSideEffects } from "@server/modules/asset/ingest-side-effects.js";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { assertAccess } from "@server/modules/project/project.service.js";

/** The throttle a link pasted on the canvas counts against, shared with it. */
const THROTTLE = "ingest-url";

/** The status the storage gate refuses with. */
const INSUFFICIENT_STORAGE = 507;

/**
 * Turn a gate's refusal into the kind the tool reads, or leave it as it is.
 * @param err - What the gate threw.
 * @returns The refusal, or the error unchanged when no gate refused.
 * @throws {never} Never.
 */
function asRefusal(err: unknown): unknown {
  if (!(err instanceof AppError)) return err;
  if (err.statusCode === INSUFFICIENT_STORAGE) return new SaveRefused("storage_full");
  if (err.statusCode === 403 || err.statusCode === 404) return new SaveRefused("no_access");
  return err;
}

/**
 * The save one turn hands its tool: bound to the project and the reader.
 * @param who - The turn's project and reader.
 * @param who.projectId - The project the picture is charged to.
 * @param who.userId - Who is saving it.
 * @returns The save.
 * @throws {never} Never; the save it returns throws.
 */
export function saveToStorageFor({ projectId, userId }: { projectId: string; userId: string }): SaveToStorage {
  return async (url, signal) => {
    const { max, windowSeconds } = getRateLimit(THROTTLE);
    const verdict = await checkRateLimit(getRedis(), [{ key: `${THROTTLE}:${userId}`, max, windowSeconds }]);
    if (!verdict.allowed) {
      logger.warn({ action: THROTTLE, key: userId }, "rate_limit_hit");
      throw new SaveRefused("rate_limited");
    }
    try {
      await assertAccess(projectId, userId, "editor");
      await assertStorageAllowance(projectId, "upload");
    } catch (err) {
      // The storage gate logs its own refusal, and an access refusal is the
      // reader's standing rather than a fault. Anything else is a fault on
      // our side, logged where the turn's project and reader are known.
      const refusal = asRefusal(err);
      if (!(refusal instanceof SaveRefused)) logger.error({ err, projectId, userId, url }, "agent_save_gate_failed");
      throw refusal;
    }

    let stored;
    try {
      stored = await backendUploadService.transferReaderUrlToStorage(
        url,
        { projectId, actingUserId: userId },
        signal,
      );
    } catch (err) {
      if (signal?.aborted === true) throw err;
      if (err instanceof backendUploadService.ReaderUrlTransferError) {
        // Only a refusal of the reader's own link is the link's to answer
        // for; one on our side is a fault, told to the model as one.
        logger[urlIngestFailureLevel(err.reason)]({ err, projectId, userId, url, reason: err.reason, reported: err.reported }, "agent_save_failed");
        if (isReaderLinkFault(err.reason)) throw new SaveRefused("link", err.reason);
        throw err;
      }
      logger.error({ err, projectId, userId, url }, "agent_save_failed");
      throw err;
    }
    noteIngestSideEffects(stored.storageKey, stored);
    return {
      url: stored.fileUrl,
      mimeType: stored.mimeType ?? "",
      width: stored.width,
      height: stored.height,
    };
  };
}
