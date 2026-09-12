// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the media container asks ffprobe and ffmpeg (#209 + #210, design §3.1).
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
 * @param objectUrl - Where the container reads the object.
 * @returns The argument list, without the program name.
 */
export function probeArgs(objectUrl: string): string[] {
  return [
    "-v",
    "error",
    "-protocol_whitelist",
    PROTOCOLS,
    "-show_entries",
    "stream=index,codec_type,codec_name,width,height:stream_side_data=rotation:stream_disposition=attached_pic:format=duration",
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
 * A PNG of a 4K frame runs past what the container may hand back — measured on
 * ffmpeg 7.1.1, a grainy 3840x2160 frame writes 14,052,786 bytes against a
 * 10 MiB ceiling, and a run that exceeds it produces no cover at all. Under
 * this filter the same source writes 2,652,027 on the binary that ships.
 *
 * Both edges are bounded because bounding one leaves the other free, and with
 * it the frame's area. Measured on ffmpeg 6.1.2 — the `~6.1` the Dockerfile
 * pins on alpine:3.22, which is what runs in the container — with a grainy
 * source already 1920 wide, so nothing is resampled away: bounding only the
 * width, 1920x3840 writes 10,196,284 bytes and 1920x5000 writes 13,273,616 —
 * the second past the ceiling, the first within 289 KiB of it. Bounding both,
 * the same two write 2,359,871 and
 * 1,774,784. The developer machine's 7.1.1 answers within 0.01% of each.
 *
 * `force_original_aspect_ratio=decrease` fits the frame inside the box and
 * leaves anything already inside it alone.
 */
const COVER_SCALE =
  "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease";

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
 * @param raw - One stream as ffprobe wrote it.
 * @returns The rotation to spread, or nothing.
 */
function spreadRotation(raw: RawStream): { rotation?: number } {
  const found = raw.side_data_list?.find(
    (side) => typeof side.rotation === "number",
  );
  return found === undefined ? {} : { rotation: found.rotation as number };
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
  let parsed: { streams?: RawStream[]; format?: { duration?: unknown } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return NOTHING_FOUND;
  }
  const streams: ProbeStream[] = (parsed.streams ?? []).map((raw) => ({
    index: raw.index ?? 0,
    codecType: raw.codec_type ?? "",
    codecName: raw.codec_name ?? null,
    width: raw.width ?? null,
    height: raw.height ?? null,
    attachedPic: raw.disposition?.attached_pic === 1,
    ...spreadRotation(raw),
  }));
  return {
    streams,
    durationSeconds: numberOrNull(parsed.format?.duration),
  };
}
