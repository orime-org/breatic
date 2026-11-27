// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
   * The rotation the stream is shown at, in degrees: its first frame's
   * `frame_side_data=rotation` when that reports one (a JPEG's EXIF
   * orientation appears only there), otherwise the stream's display matrix. The stored dimensions are what the codec holds; this is
   * what says how they are to be shown, and ffmpeg applies it on decode — so a
   * cover cut from the same run comes out already turned.
   */
  rotation?: number;
  /** A video stream's sample aspect ratio when it is not square (ffprobe's `sample_aspect_ratio`; 0:1 reads as square). */
  sampleAspectRatio?: { numerator: number; denominator: number };
  /** ffprobe's colour tags, when the stream carries them; HDR reads the source as they say. */
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  /** An audio stream's sample rate in hertz, when ffprobe read one; the audio tools resample to it. */
  sampleRate?: number;
  /** An audio stream's channel count, when ffprobe read one. */
  channels?: number;
  /** A video stream's `alpha_mode` tag, when it carries one (a VP9 or VP8 WebM with alpha says "1"). */
  alphaMode?: string;
  /**
   * A video stream's frame rate in frames per second, when ffprobe read one:
   * its `avg_frame_rate`, or `r_frame_rate` where that is `0/0`. A join
   * writes at its first clip's rate (inner#1825 §6.4).
   */
  frameRate?: number;
}

/** One /probe answer, minus the cover bytes. */
export interface ProbeReport {
  streams: ProbeStream[];
  /** ffprobe's `format.duration`, in seconds. */
  durationSeconds: number | null;
  /**
   * The square-pixel display of the real video stream's first frame as FFmpeg's default decode gives it (container crop and
   * display matrix applied; frames-split D07), when the container read one (`withDecodedDisplay`).
   */
  display?: { width: number; height: number };
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
 * ships (8.0.1, the `~8.0` the Dockerfile pins), 89.6° reports as 89 and IS
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
 * The square-pixel display of a picture (frames-split D07, §4.3 rotation/SAR row): a sample aspect ratio above 1 widens it,
 * below 1 heightens it, the scaled side rounded in double precision (102 · 13/12 is 110.49999999999999, so 110); a missing
 * or 0:n ratio reads as square. The frame-grid plan and the size an upload is filed at both take it.
 * @param frame - The picture's size and sample aspect ratio.
 * @param frame.width - Its width.
 * @param frame.height - Its height.
 * @param frame.sar - Its sample aspect ratio, `n:d`, `n/d` or a pair, if any.
 * @returns The display width and height.
 * @throws {TypeError} When the size is not positive.
 */
export function squareDisplay(frame: { width: number; height: number; sar?: string | { numerator: number; denominator: number } }): { width: number; height: number } {
  const { width, height } = frame;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new TypeError("Expected the decoded frame size");
  const pair = typeof frame.sar === "string" ? /^(\d+)[:/](\d+)$/u.exec(frame.sar)?.slice(1).map(Number) : frame.sar === undefined ? undefined : [frame.sar.numerator, frame.sar.denominator];
  const ratio = pair === undefined || !(pair[0]! > 0) || !(pair[1]! > 0) ? 1 : pair[0]! / pair[1]!;
  if (ratio > 1) return { width: Math.round(width * ratio), height };
  if (ratio < 1) return { width, height: Math.round(height / ratio) };
  return { width, height };
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
export function realVideoStream(report: ProbeReport): ProbeStream | undefined {
  return report.streams.find(
    (stream) => stream.codecType === "video" && !stream.attachedPic,
  );
}

/**
 * Whether a stored picture gets a preview cut from it.
 *
 * Only a still frame does. An APNG probes as `apng` and an animated WebP
 * probes 0x0, since the container's ffprobe cannot decode one; vips would cut
 * the first frame of either and show an animation as a still.
 * @param report - What the container answered.
 * @returns Whether to cut a preview.
 */
export function hasPreviewableFrame(report: ProbeReport): boolean {
  const media = realVideoStream(report);
  return (
    media !== undefined &&
    media.width != null &&
    media.width > 0 &&
    media.codecName !== "apng"
  );
}

/**
 * Pick the pixel dimensions and the duration out of one probe report.
 *
 * Dimensions come off the first video stream that is not attached album art —
 * an MP3 cover probes as `video, 300x300`, and taking the first video stream
 * outright would file the cover's size as the song's. Duration comes off the
 * container format rather than any stream, so it is the same number for a file
 * whose audio and video run to different lengths.
 * A video's size is its first decoded frame's display (`display`, frames-split D07); without one, the stream's coded pair
 * made square by its sample aspect ratio and turned by the display matrix. A still image is filed at its pixels, turned:
 * browsers do not show an image's pixel aspect.
 * @param report - What the container answered.
 * @param still - Whether the object is a still image.
 * @returns The three values, each null when this media has no such number.
 */
export function pickMediaMetadata(report: ProbeReport, still = false): MediaMetadata {
  const media = realVideoStream(report);
  // Both or neither: half a pair describes no frame, and a reader that got one
  // of them would have to carry its own rule for the missing one.
  const stored =
    media?.width != null && media.height != null
      ? { width: media.width, height: media.height }
      : { width: null, height: null };
  const shown = (size: { width: number; height: number }): { width: number; height: number } =>
    turnsTheFrame(media?.rotation) ? { width: size.height, height: size.width } : size;
  const sized = stored.width === null || stored.height === null ? stored
    : still ? shown({ width: stored.width, height: stored.height })
      : report.display ?? (stored.width > 0 && stored.height > 0
        ? shown(squareDisplay({ width: stored.width, height: stored.height, sar: media?.sampleAspectRatio })) : stored);
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
 * to infer from that — it was read off the bytes themselves before this runs,
 * and it is the same answer that decides whether there is a cover to cut.
 * @param storedType - What the stored bytes read as.
 * @param report - What the container answered.
 * @returns The three values, each null when this medium has no such number.
 */
export function mediaNumbersFor(
  storedType: string,
  report: ProbeReport,
): MediaMetadata {
  const still = storedType.startsWith("image/");
  const picked = pickMediaMetadata(report, still);
  if (!still) return picked;
  return { ...picked, durationSeconds: null };
}
