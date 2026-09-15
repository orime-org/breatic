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

/**
 * A report of nothing found.
 *
 * What ffprobe answers for a medium with no streams, and equally what every
 * reader on the way back answers when it could not read one — output that will
 * not parse, a container that did not finish. None of them decides whether the
 * upload succeeded, so none needs its own shape.
 */
export const NOTHING_FOUND: ProbeReport = Object.freeze({
  streams: [] as ProbeStream[],
  durationSeconds: null,
});

/** The three numbers `studio_assets` keeps. */
export interface MediaMetadata {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/**
 * Whether a display matrix puts the stored pair the other way round.
 *
 * The judgement is on an exact right angle, which is what every recorder
 * writes. ffprobe reports the angle as a whole number while ffmpeg autorotates
 * on a one-degree tolerance around the real one, so the number that arrives
 * here is ambiguous in both directions — measured on the ffmpeg the container
 * ships (6.1.2, the `~6.1` the Dockerfile pins), 89.6° reports as 89 and IS
 * turned while 89.0° also reports as 89 and is not, and 90.4° reports as 90
 * and is turned while 90.6° also reports as 90 and is not. 7.1.1 reports the
 * same number for every one of them.
 * A file has to be built by hand to carry an angle off a right angle at all.
 * @param rotation - Degrees off the stream's side data, when it carries any.
 * @returns Whether width and height swap.
 */
function turnsTheFrame(rotation: number | undefined): boolean {
  if (rotation === undefined || !Number.isFinite(rotation)) return false;
  return Math.abs(rotation) % 180 === 90;
}

/**
 * The stream that is something to look at, when the file has one.
 *
 * Not simply the first video stream: an MP3's album art probes as `video,
 * 300x300`, so a file can carry a video stream and still be nothing but sound.
 * Two questions read this — what size the frame is, and whether the container
 * is carrying a picture at all — and both of them mean this stream.
 * @param report - What the container answered.
 * @returns The stream, or undefined when there is nothing to look at.
 */
function realVideoStream(report: ProbeReport): ProbeStream | undefined {
  return report.streams.find(
    (stream) => stream.codecType === "video" && !stream.attachedPic,
  );
}

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
  return SOUND_IN.get(candidate) ?? candidate;
}

/** The audio spelling of a container that also holds film. */
const SOUND_IN: ReadonlyMap<string, string> = new Map([
  ["video/mp4", "audio/mp4"],
  ["video/webm", "audio/webm"],
]);

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
  const media = realVideoStream(report);
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
