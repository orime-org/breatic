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
 * What to cut a preview from, when to cut one at all.
 *
 * A video's preview is cut from the cover frame this run produced, a picture's
 * from the object. Nothing is cut once the preview could run past the Worker's
 * deadline: the Worker drops the whole answer at that instant, and the width,
 * the height and the cover would go with it.
 * @param run - What this run was asked and has so far.
 * @param run.wantPreview - Whether the caller asked for a preview.
 * @param run.wantCover - Whether the caller asked for a cover, which is what
 *   says the object is a video.
 * @param run.cover - The cover this run cut, when it cut one.
 * @param run.report - What ffprobe found.
 * @param run.deadlineAt - When the Worker stops waiting, in epoch ms.
 * @param run.previewTimeoutMs - How long the preview tool may run.
 * @param run.now - The container's clock now, in epoch ms.
 * @returns `cover`, `object`, or null for no preview.
 */
export function previewSource(run: {
  wantPreview: boolean;
  wantCover: boolean;
  cover: Uint8Array | null;
  report: ProbeReport;
  deadlineAt: number;
  previewTimeoutMs: number;
  now: number;
}): "cover" | "object" | null {
  if (!run.wantPreview) return null;
  if (run.deadlineAt - run.now < run.previewTimeoutMs + PREVIEW_MARGIN_MS) {
    return null;
  }
  if (run.wantCover) return run.cover === null ? null : "cover";
  return hasPreviewableFrame(run.report) ? "object" : null;
}
