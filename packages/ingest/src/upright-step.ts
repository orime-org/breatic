// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning a stored picture upright when its upload finishes (inner#1367 §4.2).
 *
 * A picture whose EXIF orientation is 2-8 is turned in one container run and
 * written back beside the bytes as received, under `uprightKeyFor(key)`. The
 * upright copy is what the upload registers as. A picture already shown as it
 * is stored, an animated one (vips autorot writes out only its first frame),
 * and anything that is not a picture are left as they are.
 */

import { previewKeyFor, uprightKeyFor, type MediaLimits, type UprightCopy } from "@breatic/shared";
import { readImageOrientation, type RangeReader } from "@ingest/image-orientation.js";
import { readMediaAtEdge, type MediaEnv } from "@ingest/media-read.js";
import { noted, noteFailure } from "@ingest/error-monitoring.js";
import { uprightObjectUrl } from "@ingest/upright-run.js";

/** Why a picture that had to be turned upright was not. */
export type UprightFailure =
  | "orientation_unread"
  | "no_deadline"
  | "start_failed"
  | "refused"
  | "unfinished"
  | "turn_failed"
  | "write_failed";

/** The stored picture a finish asks about. */
export interface StoredPicture {
  /** Its key, which holds the bytes as received. */
  storageKey: string;
  /** What the stored bytes read as. */
  contentType: string;
  /** How many bytes are stored. */
  sizeBytes: number;
  /** When the upload's task runs out, or null when the request named none. */
  deadlineAt: number | null;
  /** What to turn it under, or null when the request named none. */
  limits: MediaLimits | null;
}

/** What the step decided. */
export type UprightStep =
  | { kind: "as_is" }
  | { kind: "upright"; copy: UprightCopy; preview: Uint8Array | null }
  | { kind: "failed"; reason: UprightFailure };

/**
 * Ranged reads of a stored object.
 * @param bucket - Where it is stored.
 * @param storageKey - Its key.
 * @returns The reader.
 */
function rangeReaderOf(bucket: R2Bucket, storageKey: string): RangeReader {
  return async (offset, length) => {
    const object = await bucket.get(storageKey, { range: { offset, length } });
    if (object === null) throw new Error(`no object at ${storageKey}`);
    return new Uint8Array(await object.arrayBuffer());
  };
}

/**
 * A pixel size an object's metadata holds.
 * @param written - What was put there, when anything was.
 * @returns The size, or null when there is none to read.
 */
function pixelsOf(written: string | undefined): number | null {
  if (written === undefined) return null;
  const value = Number(written);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The upright copy standing at `uprightKey`, when there is one.
 * @param bucket - Where it is stored.
 * @param uprightKey - Its key.
 * @returns The copy as the answer states it, or null.
 */
async function standingCopy(bucket: R2Bucket, uprightKey: string): Promise<UprightCopy | null> {
  const head = await bucket.head(uprightKey).catch(noted("ingest_upright_head_failed", { uprightKey }));
  if (head === null) return null;
  const written = head.customMetadata ?? {};
  return {
    storageKey: uprightKey,
    sizeBytes: head.size,
    width: pixelsOf(written["width"]),
    height: pixelsOf(written["height"]),
  };
}

/**
 * Cut the preview an upright copy left standing by an earlier delivery lacks:
 * that delivery may have written the copy and stopped before storing it.
 * @param env - The Worker's bindings.
 * @param about - The stored picture the copy was turned from.
 * @param uprightKey - The copy's key.
 * @returns The preview to store, or null when one stands or none was cut.
 */
async function missingPreview(
  env: MediaEnv,
  about: StoredPicture,
  uprightKey: string,
): Promise<Uint8Array | null> {
  if (about.deadlineAt === null || (await env.BUCKET.head(previewKeyFor(uprightKey))) !== null) return null;
  const read = await readMediaAtEdge(env, {
    storageKey: uprightKey,
    contentType: about.contentType,
    wantCover: false,
    wantPreview: true,
    deadlineAt: about.deadlineAt,
  });
  return read.preview;
}

/**
 * Turn a stored picture upright when its orientation says to.
 * @param env - The Worker's bindings.
 * @param about - The stored picture.
 * @returns What was decided; a failure is written down here.
 */
export async function turnUprightIfTagged(
  env: MediaEnv,
  about: StoredPicture,
): Promise<UprightStep> {
  const step = await decide(env, about);
  if (step.kind === "failed" && step.reason !== "orientation_unread") {
    noteFailure("ingest_upright_failed", { storageKey: about.storageKey, reason: step.reason });
  }
  return step;
}

/**
 * The decision {@link turnUprightIfTagged} writes down.
 * @param env - The Worker's bindings.
 * @param about - The stored picture.
 * @returns What was decided.
 */
async function decide(
  env: MediaEnv,
  about: StoredPicture,
): Promise<UprightStep> {
  const { storageKey, contentType } = about;
  if (!contentType.startsWith("image/")) return { kind: "as_is" };

  const header = await readImageOrientation(
    rangeReaderOf(env.BUCKET, storageKey),
    contentType,
    about.sizeBytes,
  ).catch(noted("ingest_orientation_unread", { storageKey }));
  // Without the orientation nobody can say whether the picture would be shown
  // upright, so it is not filed as it is.
  if (header === null) return { kind: "failed", reason: "orientation_unread" };
  if (header.outOfBounds) {
    noteFailure("ingest_orientation_out_of_bounds", { storageKey }, undefined, { userInput: true });
  }
  if (header.orientation === 1 || header.animated) return { kind: "as_is" };

  // An earlier delivery of this finish already turned it.
  const uprightKey = uprightKeyFor(storageKey);
  const standing = await standingCopy(env.BUCKET, uprightKey);
  if (standing !== null) {
    return { kind: "upright", copy: standing, preview: await missingPreview(env, about, uprightKey) };
  }

  if (about.deadlineAt === null || about.limits === null) return { kind: "failed", reason: "no_deadline" };
  const { limits } = about;
  const read = await readMediaAtEdge(env, {
    storageKey,
    contentType,
    wantCover: false,
    wantPreview: true,
    deadlineAt: about.deadlineAt,
    upright: {
      order: {
        writeUrl: uprightObjectUrl(uprightKey),
        contentType,
        lossless: header.lossless,
        quality: limits.uprightJpegQuality,
        maxBytes: limits.uprightMaxBytes,
      },
      grant: { key: uprightKey, contentType, maxBytes: limits.uprightMaxBytes },
    },
  });
  if (read.missed === "unfinished" || read.missed === "start_failed" || read.missed === "refused") {
    return { kind: "failed", reason: read.missed };
  }
  if (read.upright?.state !== "written") {
    return { kind: "failed", reason: read.upright?.step === "write" ? "write_failed" : "turn_failed" };
  }
  const copy = await standingCopy(env.BUCKET, uprightKey);
  if (copy === null) return { kind: "failed", reason: "write_failed" };
  return { kind: "upright", copy, preview: read.preview };
}
