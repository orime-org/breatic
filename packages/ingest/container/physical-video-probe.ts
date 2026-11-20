// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The probe's physical video facts on the frame grid (frames-split design §5.1 step 2, §4.1, §3.2 item 7, §4.3): every video
 * packet read without `-ignore_editlist` (FFmpeg's default interpretation, the `-ss` timeline), timed by pts or else dts, and
 * the plan's colour matrix.
 */
import type { SourcePacket } from "@shared/upload/frame-grid.js";

/**
 * The ffprobe arguments that read every packet of a stream with its time, duration and flags (no decoding).
 * @param input - The source path.
 * @param stream - The stream selector, `v:0` or `a:0`.
 * @returns The arguments.
 * @throws {never} Never.
 */
export function packetProbeArgs(input: string, stream: string): string[] {
  return ["-v", "error", "-protocol_whitelist", "file", "-select_streams", stream, "-show_entries", "packet=pts,dts,duration,flags", "-of", "csv=p=0", input];
}

/**
 * An integer field of a packet row, null for N/A.
 * @param value - The field.
 * @returns The integer, or null.
 * @throws {TypeError} When it is neither.
 */
function tick(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "N/A") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("Expected an exact packet time");
  return parsed;
}

/**
 * Read the packet rows of {@link packetProbeArgs}: pts and dts in stream ticks (null when absent), the duration (0 when
 * absent), `K` keyframes and `D` packets the edit list discards.
 * @param stdout - The rows.
 * @returns The packets in file order.
 * @throws {TypeError} When a row is malformed.
 */
export function parsePackets(stdout: string): SourcePacket[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "").map((line) => {
    const [pts, dts, duration, flags = ""] = line.split(",");
    return { pts: tick(pts), dts: tick(dts), duration: tick(duration) ?? 0, keyframe: flags.startsWith("K"), discard: flags.includes("D") };
  });
}

/**
 * Tagged ffprobe `color_space` values and the matrix the plan records for them: every matrix the recipes decode.
 */
export const TAGGED_MATRICES: Readonly<Record<string, string>> = { bt709: "bt709", smpte170m: "bt601", bt470bg: "bt601", bt2020nc: "bt2020nc", smpte240m: "smpte240m", fcc: "fcc" };

/**
 * Resolve the colour matrix once for the plan (§4.3): a tag in `TAGGED_MATRICES` is kept; any other stream is BT.709 when its
 * coded height is at least 720 and BT.601 otherwise, whatever its rotation.
 * @param stream - The selected ffprobe stream.
 * @returns The matrix.
 * @throws {TypeError} When an untagged stream has no positive integer coded height.
 */
export function resolveVideoColorMatrix(stream: Record<string, unknown>): string {
  const tag = stream.color_space;
  if (typeof tag === "string" && Object.hasOwn(TAGGED_MATRICES, tag)) return TAGGED_MATRICES[tag]!;
  const height = stream.height;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) throw new TypeError("Expected the coded video height");
  return height >= 720 ? "bt709" : "bt601";
}

/**
 * The square-pixel display size of the first decoded frame (§4.3 rotation/SAR row, D07): a sample aspect ratio above 1 widens
 * it, below 1 heightens it, rounded; 0:1 reads as 1:1.
 * @param frame - The decoded frame's size and sample aspect ratio.
 * @param frame.width - Its width.
 * @param frame.height - Its height.
 * @param frame.sar - Its sample aspect ratio, `n:d` or `n/d`, if any.
 * @returns The display width and height.
 * @throws {TypeError} When the size is not positive.
 */
export function squareDisplay(frame: { width: number; height: number; sar?: string }): { width: number; height: number } {
  const { width, height } = frame;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new TypeError("Expected the decoded frame size");
  const match = /^(\d+)[:/](\d+)$/u.exec(frame.sar ?? "");
  const ratio = match === null || Number(match[1]) === 0 || Number(match[2]) === 0 ? 1 : Number(match[1]) / Number(match[2]);
  if (ratio > 1) return { width: Math.round(width * ratio), height };
  if (ratio < 1) return { width, height: Math.round(height / ratio) };
  return { width, height };
}
