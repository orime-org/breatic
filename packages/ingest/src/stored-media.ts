// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the Worker makes of a probe report (#240).
 *
 * Apart from `media-metadata.ts` because that file is shared with the media
 * container, which runs on Node in an image holding no workspace packages — its
 * tsconfig names every file it takes, so an import reaching further stops
 * compiling there. This reads the shared media-type list; the container does
 * not read this.
 */

import { isUploadableMediaType } from "@breatic/shared";

import type { ProbeReport } from "@ingest/media-metadata.js";
import { realVideoStream } from "@ingest/media-metadata.js";

/**
 * What one container carrying only sound is, given what the bytes said.
 *
 * A container says which container it is, not what is inside it: ffmpeg's
 * default MP4 muxer writes the same brand for a film and for a piece of music,
 * and WebM has no separate magic for sound either. So a voiceover reads as
 * `video/…` off its bytes, and registering it that way puts it on the canvas
 * as a video node with nothing to show.
 *
 * Only the two containers that hold either are corrected. QuickTime has no
 * audio spelling on the list of what we store, so a candidate this cannot
 * answer for is left as it was rather than turned into something unstorable.
 *
 * A report with no streams in it is not a report of silence — it is what every
 * reader on the way back answers when it could not read one, a container that
 * would not start or ran out of time included. It says nothing about what is
 * in the file, so what the bytes said stands.
 * @param candidate - What the stored bytes read as.
 * @param report - What the container answered.
 * @returns The type to register, corrected only where the report says to.
 */
export function typeCorrectedByReport(
  candidate: string,
  report: ProbeReport,
): string {
  if (report.streams.length === 0) return candidate;
  if (realVideoStream(report) !== undefined) return candidate;
  // The audio spelling of the same container, kept only where the list knows
  // it: `video/quicktime` has no `audio/quicktime` to become, and a candidate
  // outside the `video/` family has nothing to rewrite. Derived rather than
  // tabulated, so a container the list gains later needs nothing here.
  const sound = candidate.replace(/^video\//, "audio/");
  return isUploadableMediaType(sound) ? sound : candidate;
}
