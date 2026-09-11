// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the media container reports, and which of it the ledger keeps
 * (#209 + #210, design §4.2).
 *
 * The container runs one ffprobe over whatever key it was handed and answers
 * with every stream it found. It judges nothing: it does not know whether the
 * bytes are a photo, a song or a film, and asking it to decide would put the
 * same judgement in two places. Picking the numbers out is this side's job,
 * and it is the half of the contract that has a rule worth stating.
 */

/** One stream as the container reports it. */
export interface ProbeStream {
  index: number;
  codecType: string;
  codecName: string | null;
  width: number | null;
  height: number | null;
  /**
   * ffprobe's `stream_disposition=attached_pic`. An MP3 with album art carries
   * a video stream of the cover's size, and this is what tells it apart from
   * a stream anyone would call the media's own.
   */
  attachedPic: boolean;
  /**
   * ffprobe's `stream_side_data=rotation`, in degrees, when the stream carries
   * a display matrix. The stored dimensions are what the codec holds; this is
   * what says how they are to be shown, and ffmpeg applies it on decode — so a
   * cover cut from the same run comes out already turned.
   */
  rotation?: number;
}

/** One /probe answer, minus the cover bytes. */
export interface ProbeReport {
  streams: ProbeStream[];
  /** ffprobe's `format.duration`, in seconds. */
  durationSeconds: number | null;
}

/** The three numbers `studio_assets` keeps. */
export interface MediaMetadata {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/**
 * Whether a display matrix puts the stored pair the other way round.
 * @param rotation - Degrees off the stream's side data, when it carries any.
 * @returns Whether width and height swap.
 */
function turnsTheFrame(rotation: number | undefined): boolean {
  if (rotation === undefined) return false;
  return Math.abs(rotation) % 180 === 90;
}

/**
 * Pick the pixel dimensions and the duration out of one probe report.
 *
 * Dimensions come off the first video stream that is not attached album art —
 * an MP3 cover probes as `video, 300x300`, and taking the first video stream
 * outright would file the cover's size as the song's. Duration comes off the
 * container format rather than any stream, so it is the same number for a file
 * whose audio and video run to different lengths.
 * @param report - What the container answered.
 * @returns The three values, each null when this media has no such number.
 */
export function pickMediaMetadata(report: ProbeReport): MediaMetadata {
  const media = report.streams.find(
    (stream) => stream.codecType === "video" && !stream.attachedPic,
  );
  // Both or neither: half a pair describes no frame, and a reader that got one
  // of them would have to carry its own rule for the missing one.
  const stored =
    media?.width != null && media.height != null
      ? { width: media.width, height: media.height }
      : { width: null, height: null };
  const sized = turnsTheFrame(media?.rotation)
    ? { width: stored.height, height: stored.width }
    : stored;
  // A still image probes with a format duration of zero often enough to matter,
  // and zero seconds is not a duration anyone can act on.
  const duration =
    report.durationSeconds != null && report.durationSeconds > 0
      ? report.durationSeconds
      : null;
  return { ...sized, durationSeconds: duration };
}

/**
 * The three numbers as the ledger files them for one upload.
 *
 * ffprobe answers a still photograph with the duration of one frame at the
 * demuxer's default rate, and which demuxer it picks varies from file to file:
 * measured, one JPEG read as `image2` and answered 0.04 seconds while another
 * read as `jpeg_pipe` and answered none. What the bytes are is not something
 * to infer from that — the ticket signed it, and it is the same authority that
 * decides whether there is a cover to cut.
 * @param contentType - What the ticket signed for these bytes.
 * @param report - What the container answered.
 * @returns The three values, each null when this medium has no such number.
 */
export function mediaNumbersFor(
  contentType: string,
  report: ProbeReport,
): MediaMetadata {
  const picked = pickMediaMetadata(report);
  if (!contentType.startsWith("image/")) return picked;
  return { ...picked, durationSeconds: null };
}
