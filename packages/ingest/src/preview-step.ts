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
 * Time kept back between the end of a preview and the Worker's deadline. The
 * deadline is an instant the Worker named on its own clock, and the container
 * compares it against another.
 */
export const PREVIEW_MARGIN_MS = 5_000;

/**
 * How long the preview tool may run: the rest of the run but the margin.
 *
 * The preview is the last thing a run does, and nothing waits on it but the
 * answer, so it has no figure of its own (inner#1339: a 1080x64800 PNG takes
 * vips about 22 seconds on the lite type and about 5 on basic).
 * @param run - The deadline and the clock.
 * @param run.deadlineAt - When the Worker stops waiting, in epoch ms.
 * @param run.now - The container's clock now, in epoch ms.
 * @returns Milliseconds, zero or less when nothing is left.
 */
export function previewTimeLeft(run: { deadlineAt: number; now: number }): number {
  return run.deadlineAt - run.now - PREVIEW_MARGIN_MS;
}

/**
 * What to cut a preview from, when to cut one at all.
 *
 * A video's preview is cut from the cover frame this run produced, a picture's
 * from the object. Nothing is cut once no time is left before the Worker's
 * deadline: the Worker drops the whole answer at that instant, and the width,
 * the height and the cover would go with it.
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
  return previewTimeLeft(run) <= 0 ? "late" : source;
}
