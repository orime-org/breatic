// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether the media container cuts a preview, and from what (inner#1320).
 *
 * Decided here rather than inside the container's handler so it runs without
 * Docker. The container reads this and does what it says.
 */

import { hasPreviewableFrame } from "@ingest/media-metadata.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

/**
 * What to cut a preview from, when to cut one at all.
 *
 * A video's preview is cut from the cover frame this run produced, a picture's
 * from the object. Nothing is cut once the task's deadline has come
 * (inner#1367): the Worker stops waiting then.
 * @param run - What this run was asked and has so far.
 * @param run.wantPreview - Whether the caller asked for a preview.
 * @param run.wantCover - Whether the caller asked for a cover, which is what
 *   says the object is a video.
 * @param run.cover - The cover this run cut, when it cut one.
 * @param run.report - What ffprobe found.
 * @param run.deadlineAt - When the Worker stops waiting, in epoch ms.
 * @param run.now - The container's clock now, in epoch ms.
 * @returns `cover` or `object` for where to cut it from, `late` when one was
 *   asked for but no time is left, or null for no preview.
 */
export function previewSource(run: {
  wantPreview: boolean;
  wantCover: boolean;
  cover: Uint8Array | null;
  report: ProbeReport;
  deadlineAt: number;
  now: number;
}): "cover" | "object" | "late" | null {
  if (!run.wantPreview) return null;
  const source = run.wantCover
    ? run.cover === null
      ? null
      : "cover"
    : hasPreviewableFrame(run.report)
      ? "object"
      : null;
  if (source === null) return null;
  return run.deadlineAt - run.now <= 0 ? "late" : source;
}
