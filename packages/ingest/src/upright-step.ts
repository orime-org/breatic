// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The finish's side of turning a picture upright (inner#1367 design §4.1).
 *
 * A picture's orientation is read off its head with ranged reads. One shown at
 * 2-8 is handed to its key's arbiter; one whose orientation could not be read
 * seals the key, so nothing turns it after this finish has answered for it.
 * Whatever the arbiter says, the answer the finish gives is read off the
 * object afterwards (`groundOnObject`): the arbiter decides at most once what
 * stands at the key, and the object is what says what that was.
 */

import { PREVIEW_MARGIN_MS, type MediaLimits } from "@breatic/shared";
import { noteFailure } from "@ingest/error-monitoring.js";
import { readImageOrientation, type RangeReader } from "@ingest/image-orientation.js";
import type { MediaMetadata } from "@ingest/media-metadata.js";
import type { MediaEnv } from "@ingest/media-read.js";
import { runWindowLeft } from "@ingest/run-window.js";
import { hashStoredObject } from "@ingest/stored-object.js";
import { RECEIVED_SHA256, type ArbiterAnswer, type ArbiterAsk } from "@ingest/upright-arbiter.js";

/** How long to wait before asking an arbiter again after a failed call. */
const ASK_RETRY_MS = 300;

/** What the upright step left the finish to do. */
export interface UprightOutcome {
  /** What the arbiter's run measured on the written picture, when it did. */
  media: MediaMetadata | null;
  /** The instant every later step of this finish is held to (D). */
  finishBy: number;
}

/** What one finish answers for the object it stored. */
export interface GroundedObject {
  sha256: string;
  sizeBytes: number;
  /** The hash of the bytes as received; the stored hash unless the picture was turned. */
  receivedSha256: string;
}

/**
 * Hand a picture carrying an orientation to its arbiter.
 * @param env - The Worker's bindings.
 * @param about - The stored picture.
 * @param about.storageKey - Its key.
 * @param about.contentType - What its bytes read as.
 * @param about.sha256 - The hash of the bytes as received.
 * @param about.limits - The run's limits, when the caller named any.
 * @param about.answerBy - When the caller stops waiting, when it said.
 * @returns What the arbiter left, or null when the picture has no orientation
 *   to apply.
 */
export async function uprightStep(
  env: MediaEnv,
  about: {
    storageKey: string;
    contentType: string;
    sha256: string;
    limits: MediaLimits | null;
    answerBy: number | null;
  },
): Promise<UprightOutcome | null> {
  const read = await readImageOrientation(rangeReaderOf(env.BUCKET, about.storageKey), about.contentType);
  if (read !== "unreadable" && read.orientation === 1) return null;
  if (read === "unreadable") noteFailure("ingest_orientation_unread", { storageKey: about.storageKey });

  const now = Date.now();
  const window = runWindowLeft(about.limits, about.answerBy, now);
  const quality = about.limits?.uprightJpegQuality;
  const finishBy = window === null ? now : now + window.runDeadlineMs - PREVIEW_MARGIN_MS;
  const turnable = read !== "unreadable" && window !== null && quality !== undefined && finishBy > now;
  const ask: ArbiterAsk = {
    kind: turnable ? "request" : "seal",
    storageKey: about.storageKey,
    receivedSha256: about.sha256,
    lossless: read !== "unreadable" && read.lossless,
    contentType: about.contentType,
    quality: quality ?? 0,
    toolTimeoutMs: about.limits?.toolTimeoutMs ?? 0,
    waitBy: finishBy,
  };
  const answer = await askUntil(env, ask);
  return { media: answer?.phase === "done" ? answer.media : null, finishBy };
}

/**
 * Ask the key's arbiter, asking again after a failed call until `waitBy`.
 * @param env - The Worker's bindings.
 * @param ask - What to ask.
 * @returns Its answer, or null when no call got through in time.
 */
async function askUntil(env: MediaEnv, ask: ArbiterAsk): Promise<ArbiterAnswer | null> {
  const arbiter = env.MEDIA.get(env.MEDIA.idFromName(ask.storageKey));
  for (;;) {
    try {
      return await arbiter.askUpright(ask);
    } catch (err) {
      noteFailure("ingest_upright_ask_failed", { storageKey: ask.storageKey, kind: ask.kind }, err);
      if (Date.now() + ASK_RETRY_MS >= ask.waitBy) return null;
      await new Promise((resolve) => setTimeout(resolve, ASK_RETRY_MS));
    }
  }
}

/**
 * What the finish answers for a stored picture, read off the object as it now stands.
 * @param bucket - The bucket.
 * @param storageKey - The picture's key.
 * @param first - What this finish measured before anything could turn it.
 * @param first.sha256 - Its hash then.
 * @param first.sizeBytes - Its size then.
 * @returns The hash and size of what stands, and the hash of what was received.
 */
export async function groundOnObject(
  bucket: R2Bucket,
  storageKey: string,
  first: { sha256: string; sizeBytes: number },
): Promise<GroundedObject> {
  const stored = await bucket.head(storageKey);
  const received = stored?.customMetadata?.[RECEIVED_SHA256];
  if (stored === null || received === undefined) {
    return { sha256: first.sha256, sizeBytes: first.sizeBytes, receivedSha256: first.sha256 };
  }
  return { sha256: await hashStoredObject(bucket, storageKey), sizeBytes: stored.size, receivedSha256: received };
}

/**
 * Ranged reads of one stored object.
 * @param bucket - The bucket.
 * @param storageKey - The object.
 * @returns A reader; it throws when R2 refuses or the object is gone.
 */
function rangeReaderOf(bucket: R2Bucket, storageKey: string): RangeReader {
  return async (offset, length) => {
    const part = await bucket.get(storageKey, { range: { offset, length } });
    if (part === null) throw new Error(`no object at ${storageKey}`);
    return new Uint8Array(await part.arrayBuffer());
  };
}
