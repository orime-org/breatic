// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { assetRepo } from "@breatic/domain";
import { assertBeforeDeadline, httpRequest, readBytesWithin, untilDeadline, type StudioAssetEntity } from "@breatic/shared";
import { HttpStatusError } from "@worker/providers/http.js";

/** A registered object and its JSON, ready for the operation's content parser. */
export interface RegisteredAnalysisJson { asset: StudioAssetEntity; json: unknown }

/**
 * Read a registered analysis artifact within its bound.
 * @param assetId - The canonical asset returned by the original registration.
 * @param deadlineAt - The read's bound in epoch milliseconds (the caller's `planReadUntil`).
 * @returns The registered facts and parsed JSON without changing their ownership.
 * @throws {Error} When registration, delivery, the original budget or JSON is invalid.
 */
export async function readMiniToolAnalysisJson(assetId: string, deadlineAt: number): Promise<RegisteredAnalysisJson> {
  assertBeforeDeadline(deadlineAt);
  const asset = await assetRepo.findById(assetId);
  if (asset === null || asset.deletedAt !== null) throw new Error("Registered analysis artifact is unavailable");
  const response = await httpRequest(asset.fileUrl, { method: "GET" }, { replaySafe: true, ...untilDeadline(deadlineAt) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpStatusError("analysis artifact", response.status, "");
  }
  const bound = untilDeadline(deadlineAt);
  const bytes = await readBytesWithin(response, bound.timeoutMs, asset.sizeBytes, bound.signal);
  assertBeforeDeadline(deadlineAt);
  const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return { asset, json };
}
