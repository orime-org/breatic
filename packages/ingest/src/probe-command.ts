// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the media container asks ffprobe, ffmpeg and vips (#209 + #210, design
 * §3.1; inner#1339).
 *
 * The argument lists live here, beside the Worker that starts the container,
 * because they are the whole of what happens to a user's bytes and they are
 * asserted without Docker. The container imports them and does nothing else to
 * decide what to run.
 */

import { NOTHING_FOUND } from "@ingest/media-metadata.js";
import type { ProbeReport, ProbeStream } from "@ingest/media-metadata.js";

/**
 * The protocols ffmpeg may open.
 *
 * ffmpeg follows what a container format tells it to open — an HLS playlist, a
 * concat script, a subtitle path — so the input file decides what gets fetched
 * unless this says otherwise. The object is served over plain HTTP from the
 * Worker's own outbound handler, so that is the whole list (#215).
 */
const PROTOCOLS = "http,tcp";

/**
 * The one ffprobe call that covers image, video and audio.
 *
 * `stream_disposition` is a section name of its own: asked for inside
 * `stream=` it comes back empty, and an MP3's album art then reads as an
 * ordinary video stream (measured, `2026-09-10-ffprobe-attached-picture.sh`).
 *
 * The first frame is read as well, because a JPEG's EXIF orientation shows up
 * only on its decoded frame: the stream section of a phone photo taken upright
 * reports the sensor's landscape pair and no rotation. `%+#1` stops after one
 * packet, so a long video costs no more than a photo.
 * @param objectUrl - Where the container reads the object.
 * @returns The argument list, without the program name.
 */
export function probeArgs(objectUrl: string): string[] {
  return [
    "-v",
    "error",
    "-protocol_whitelist",
    PROTOCOLS,
    "-read_intervals",
    "%+#1",
    "-show_entries",
    "stream=index,codec_type,codec_name,width,height:stream_side_data=rotation:stream_disposition=attached_pic:format=duration:frame=stream_index:frame_side_data=rotation",
    "-of",
    "json",
    objectUrl,
  ];
}

/**
 * What a cut frame is, decided by the arguments below.
 *
 * It is stored on the R2 object and filed on the cover's ledger row, so it is
 * named once here rather than written out at each of those.
 */
export const COVER_CONTENT_TYPE = "image/png";

/**
 * The one ffmpeg call that lifts a cover frame.
 *
 * PNG straight out, so the frame never passes through a lossy encode on its
 * way to becoming one (the earlier worker path went MJPEG then re-encoded).
 * @param objectUrl - Where the container reads the object.
 * @returns The argument list, without the program name.
 */
export function coverArgs(objectUrl: string): string[] {
  return [
    "-v",
    "error",
    "-protocol_whitelist",
    PROTOCOLS,
    "-i",
    objectUrl,
    "-vframes",
    "1",
    "-vf",
    COVER_SCALE,
    "-f",
    "image2",
    "-vcodec",
    "png",
    "pipe:1",
  ];
}

/**
 * How large a cut frame may be, on both edges.
 *
 * A PNG of a 4K frame runs past what the container may hand back, and a run
 * that exceeds the 10 MiB ceiling produces no cover at all. Measured on
 * ffmpeg 8.0.1 — the `~8.0` the Dockerfile pins on alpine:3.23, which is what
 * runs in the container — with grainy sources made by
 * `testsrc2=s=<size>,noise=alls=80:allf=t`: a 3840x2160 frame writes
 * 22,148,799 bytes unscaled and 5,269,284 under this filter.
 *
 * Both edges are bounded because bounding one leaves the other free, and with
 * it the frame's area. On the same binary and sources, already 1920 wide so
 * nothing is resampled away by a width bound: bounding only the width,
 * 1920x3840 writes 19,711,839 bytes and 1920x5000 writes 25,668,806, both past
 * the ceiling. Bounding both, the same two write 4,705,535 and 3,765,679.
 *
 * `force_original_aspect_ratio=decrease` fits the frame inside the box and
 * leaves anything already inside it alone.
 */
const COVER_SCALE =
  "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease";

/** What vips writes a preview as. */
export const PREVIEW_CONTENT_TYPE = "image/webp";

/**
 * The one vips call that writes a preview (inner#1320, inner#1339).
 *
 * The picture arrives on stdin — the stored object or a video's cover frame —
 * and vips decodes it a strip at a time, shrinking as it reads, so a 1080x64800
 * PNG peaks at 57 MiB where ffmpeg, which decodes the whole frame first, is
 * killed in a 256 MiB container.
 *
 * The box is 576 wide by WebP's side limit, and `--size down` leaves a smaller
 * picture at its own size; the width that comes out is what `previewWidthFor`
 * in `@breatic/shared` gives, which the page compares against. The container
 * cannot import it, so the test holds the two together. vips turns a picture
 * by its EXIF orientation, so the preview comes out the way the picture is
 * shown. `keep=icc` carries the colour profile across: a Display P3 picture
 * without it is shown as sRGB, duller than the original.
 * @returns The argument list, without the program name.
 */
export function previewArgs(): string[] {
  return [
    "thumbnail_source",
    "[descriptor=0]",
    ".webp[Q=80,keep=icc]",
    "576",
    "--height",
    "16383",
    "--size",
    "down",
  ];
}

/** One stream as ffprobe writes it. */
interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: unknown }[];
}

/**
 * Read one number ffprobe wrote as text.
 *
 * It writes `"N/A"` for anything it could not determine, which is not a
 * duration and is not zero either.
 * @param raw - The field as written.
 * @returns The number, or null when there is none.
 */
function numberOrNull(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The display matrix's rotation, when the stream carries one.
 *
 * It arrives in its own section: ffprobe writes a `side_data_list` per stream,
 * and a stream with no matrix has no list at all. Spread rather than set, so a
 * stream that carries none has no key instead of an undefined one.
 * @param raw - One stream or frame as ffprobe wrote it.
 * @returns The rotation to spread, or nothing.
 */
function spreadRotation(raw: {
  side_data_list?: { rotation?: unknown }[];
}): { rotation?: number } {
  const found = raw.side_data_list?.find(
    (side) => typeof side.rotation === "number",
  );
  return found === undefined ? {} : { rotation: found.rotation as number };
}

/** One frame as ffprobe writes it under `-read_intervals %+#1`. */
interface RawFrame {
  stream_index?: number;
  side_data_list?: { rotation?: unknown }[];
}

/**
 * The rotation a stream is shown at.
 *
 * One angle, taken once: the first frame of this stream when it reports one,
 * since that is where a JPEG's EXIF orientation appears, and otherwise the
 * stream's own display matrix. A rotated video reports the same angle in both
 * places, and reading both would turn it back.
 * @param raw - One stream as ffprobe wrote it.
 * @param frames - The frames ffprobe read.
 * @returns The rotation to spread, or nothing.
 */
function rotationOf(raw: RawStream, frames: RawFrame[]): { rotation?: number } {
  const frame = frames.find((f) => f.stream_index === (raw.index ?? 0));
  const fromFrame = frame === undefined ? {} : spreadRotation(frame);
  return "rotation" in fromFrame ? fromFrame : spreadRotation(raw);
}

/**
 * Read ffprobe's JSON into the shape the container answers with.
 *
 * Output it cannot read answers as nothing found, which is what a medium with
 * no streams looks like too — neither decides whether the upload succeeded, so
 * they need not be told apart.
 * @param stdout - What ffprobe wrote.
 * @returns The normalised report.
 */
export function readProbeOutput(stdout: string): ProbeReport {
  let parsed: {
    streams?: RawStream[];
    frames?: RawFrame[];
    format?: { duration?: unknown };
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return NOTHING_FOUND;
  }
  const frames = parsed.frames ?? [];
  const streams: ProbeStream[] = (parsed.streams ?? []).map((raw) => ({
    index: raw.index ?? 0,
    codecType: raw.codec_type ?? "",
    codecName: raw.codec_name ?? null,
    width: raw.width ?? null,
    height: raw.height ?? null,
    attachedPic: raw.disposition?.attached_pic === 1,
    ...rotationOf(raw, frames),
  }));
  return {
    streams,
    durationSeconds: numberOrNull(parsed.format?.duration),
  };
}
