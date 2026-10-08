// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading an upload's media numbers after it returns (#299).
 *
 * A project cover or a studio avatar has nothing on screen that waits on its
 * resolution, and reading one at finish meant waiting on a media container's
 * cold start. So those two are finished without a read, and a job reads the
 * stored object afterwards and fills the row. Every other upload still reads
 * at finish.
 *
 * What a row's numbers are for is the next upload of the same bytes: a dedup
 * hit has no container run of its own and reads them off this row.
 */

import { createQueue, defaultJobOpts, env } from "@breatic/core";
import { readStoredMediaAtIngest, type StudioAssetEntity } from "@breatic/shared";

import { fillMediaNumbers, findById } from "@domain/asset/asset.repo.js";
import { detectAssetKind, mediaLimits } from "@domain/asset/asset.service.js";
import type { IngestReportOutcome } from "@domain/asset/ingest-report.service.js";

/** The queue the read travels on. */
export const MEDIA_READ_QUEUE = "media-read";

/** One read, as the worker receives it. */
export interface MediaReadJob {
  assetId: string;
}

/** What one read job did with its row. */
export type MediaReadResult =
  | "filled"
  | "already_measured"
  | "nothing_found"
  | "gone";

/** The uploads whose numbers are read after the upload returns. */
const READ_LATER: ReadonlySet<StudioAssetEntity["source"]> = new Set([
  "project_cover",
  "studio_avatar",
]);

/**
 * Whether an upload's media numbers are read while it is being finished.
 * @param source - What the grant says the upload is, or null when it says
 *   nothing (a canvas upload).
 * @returns False for a project cover or a studio avatar, true for the rest.
 */
export function readsMediaAtFinish(
  source: StudioAssetEntity["source"] | null,
): boolean {
  return source === null || !READ_LATER.has(source);
}

/**
 * Whether an upload with a purpose may be of this type.
 *
 * A cover or an avatar can only ever be pointed at a picture, so a purpose is
 * taken for a picture alone — which is also what deferring its read rests on.
 * @param contentType - The type the ticket names, or the stored bytes read as.
 * @returns True for a picture.
 */
export function purposeAccepts(contentType: string): boolean {
  return detectAssetKind(contentType) === "image";
}

/**
 * Whether what the stored bytes read as may be registered under this source.
 *
 * The ticket's type is a claim; this is the one the edge read off the bytes.
 * An upload with a purpose is held to a picture here too, so one whose bytes
 * turn out to be a film is refused rather than filed without its numbers.
 * @param source - What the grant says the upload is.
 * @param contentType - What the stored bytes read as.
 * @returns False only for an upload with a purpose whose bytes are no picture.
 */
export function storedTypeAccepted(
  source: StudioAssetEntity["source"] | null,
  contentType: string,
): boolean {
  return readsMediaAtFinish(source) || purposeAccepts(contentType);
}

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * Whether a row holds none of the three media numbers.
 * @param numbers - The row's numbers.
 * @param numbers.width - Pixel width, or null.
 * @param numbers.height - Pixel height, or null.
 * @param numbers.durationSeconds - Running time, or null.
 * @returns True when all three are null.
 */
function hasNoNumbers(numbers: {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}): boolean {
  return (
    numbers.width === null &&
    numbers.height === null &&
    numbers.durationSeconds === null
  );
}

/**
 * Queue a read for a finished upload, when it needs one.
 *
 * Four things have to hold: the upload deferred its read, it registered, the
 * row it registered is its own, and that row has no numbers. The third is
 * what keeps a cover whose bytes the studio already held off somebody else's
 * row. A re-delivered finish answers out of the row the first one wrote: once
 * that row has numbers nothing is queued, and while it is still empty it
 * queues again — the job id folds the two into one while the first job is
 * kept, and after that a second read runs.
 * @param outcome - What the report handler decided.
 * @param assetSource - What the grant says the upload is.
 * @returns True when a job was queued.
 */
export async function scheduleMediaRead(
  outcome: IngestReportOutcome,
  assetSource: StudioAssetEntity["source"] | null,
): Promise<boolean> {
  if (readsMediaAtFinish(assetSource)) return false;
  if (outcome.status !== "registered" && outcome.status !== "already_registered") {
    return false;
  }
  if (!outcome.ownRow) return false;
  if (!hasNoNumbers(outcome)) return false;

  queue ??= createQueue(MEDIA_READ_QUEUE);
  const job: MediaReadJob = { assetId: outcome.assetId };
  // BullMQ refuses a custom id that contains a colon.
  await queue.add("read", job, {
    ...defaultJobOpts(),
    jobId: `media-read-${outcome.assetId}`,
  });
  return true;
}

/**
 * Read one row's stored object and fill the row.
 *
 * The type sent is the one the ledger recorded off the stored bytes. A refusal
 * from the Worker or a dead network is thrown, for the queue to retry.
 * @param assetId - The row.
 * @returns What became of the row.
 * @throws {unknown} When the Worker refused or could not be reached.
 */
export async function readAndFillMedia(assetId: string): Promise<MediaReadResult> {
  const row = await findById(assetId);
  if (row === null || row.deletedAt !== null) return "gone";
  if (!hasNoNumbers(row)) return "already_measured";

  const numbers = await readStoredMediaAtIngest(
    env.INGEST_BASE_URL,
    env.INGEST_SHARED_SECRET,
    {
      storageKey: row.storageKey,
      contentType: row.mimeType,
      limits: mediaLimits(),
      // Every stored image gets a preview (inner#1320); the rows read here
      // were finished without a container run, so this is where theirs is cut.
      wantPreview: row.mimeType.startsWith("image/"),
    },
  );
  if (hasNoNumbers(numbers)) return "nothing_found";
  // The write only lands on a live row that is still unmeasured, so losing it
  // means another write filled the row or it was deleted meanwhile; either
  // way there is nothing left to write.
  return (await fillMediaNumbers(assetId, numbers)) ? "filled" : "already_measured";
}
