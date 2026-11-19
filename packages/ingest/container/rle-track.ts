// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tracking output as the recipes read it (execution design §10.2): a SAM3 track is a JSON array of COCO compressed counts,
 * one per frame in order, null for a frame without a mask; and a video's presentation times, by its packets.
 */
import { readFile } from "node:fs/promises";
import { decodeCocoRleMask } from "@shared/mini-tools/coco-rle.js";
import { runPlanCommand, type PlanCommandOptions } from "@ingest/container/plan-command.js";
import { RecipeFailure } from "@ingest/container/presentation-recipes.js";

/**
 * Read an RLE track.
 * @param file - The track.
 * @returns Its entries.
 * @throws {RecipeFailure} `tracking_output_mismatch` when the file is not such an array.
 */
export async function readRleTrack(file: string): Promise<(string | null)[]> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch { throw new RecipeFailure("tracking_output_mismatch"); }
  if (!Array.isArray(value) || !value.every((item) => item === null || typeof item === "string")) throw new RecipeFailure("tracking_output_mismatch");
  return value as (string | null)[];
}

/**
 * One frame's mask, `on` on the foreground and 0 elsewhere; all 0 without a mask.
 * @param counts - The frame's counts, or null.
 * @param size - The mask's size.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @param on - The value of a foreground pixel.
 * @returns One byte per pixel.
 * @throws {RecipeFailure} `tracking_output_mismatch` when the counts do not cover the size.
 */
export function rleForeground(counts: string | null, size: { width: number; height: number }, on: number): Uint8Array {
  if (counts === null) return new Uint8Array(size.width * size.height);
  let mask: Uint8Array;
  try { mask = decodeCocoRleMask({ size: [size.height, size.width], counts }, size); } catch { throw new RecipeFailure("tracking_output_mismatch"); }
  // The decoder writes VOID bytes: foreground 0, background 255.
  return mask.map((value) => (value === 0 ? on : 0));
}

/**
 * A video's frame presentation times in seconds, in presentation order, as ffprobe reads its packets, and its stream's
 * colour tags.
 * @param file - The video.
 * @param run - The lifetime and IO bounds.
 * @returns The sorted times and the stream's `color_space` and `color_range`.
 * @throws {Error} When ffprobe fails.
 */
export async function presentationTimes(file: string, run: PlanCommandOptions): Promise<{ times: number[]; stream: Record<string, unknown> }> {
  const answer = JSON.parse((await runPlanCommand("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries",
    "stream=color_space,color_range:packet=pts_time", "-of", "json", file], run)).toString("utf8")) as
    { streams?: Record<string, unknown>[]; packets?: { pts_time?: string }[] };
  return { times: (answer.packets ?? []).map((packet) => Number(packet.pts_time)).filter(Number.isFinite).sort((a, b) => a - b), stream: answer.streams?.[0] ?? {} };
}
