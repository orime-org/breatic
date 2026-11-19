// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The picture a video source shows, as Chromium shows it (measured in Chromium 151 and Chrome 157): container cropping is not
 * applied, neither a Matroska PixelCrop nor an MP4 clean aperture, so every decode of a source keeps codec cropping only
 * (`CODEC_CROPPING_ONLY`; FFmpeg's decoders would apply both); a non-square sample aspect ratio is shown at Chromium's natural
 * size (`naturalSize` in `@ingest/media-metadata.js`), which the plan's display geometry and the size an upload is filed at
 * both take.
 */

import { pickMediaMetadata, realVideoStream, type ProbeReport } from "@ingest/media-metadata.js";

/** The decoder input options that apply codec cropping and no container cropping. */
export const CODEC_CROPPING_ONLY: readonly string[] = ["-apply_cropping", "codec"];

/** One entry of a stream's ffprobe side data, as far as the picture's turn reads it. */
export interface PictureSideData { side_data_type?: unknown; displaymatrix?: unknown; rotation?: unknown; [field: string]: unknown }

/** The turn FFmpeg's autorotate applies, and which output directions it reverses. */
export interface DisplayTurn { filter: string | null; transposed: boolean; x: boolean; y: boolean }

/**
 * The turn FFmpeg's autorotate applies for a display matrix (fftools/ffmpeg_filter.c, FFmpeg 8): a transpose for a quarter
 * turn, flips for a half turn or a mirror; and which output directions it reverses.
 * @param side - The stream's side data.
 * @returns The turn's filter (null for none), whether it transposes, and the reversed directions.
 * @throws {never} Never.
 */
export function displayTurn(side: readonly PictureSideData[] | undefined): DisplayTurn {
  const entry = side?.find((item) => typeof item.displaymatrix === "string");
  if (entry === undefined) return { filter: null, transposed: false, x: false, y: false };
  const m = (entry.displaymatrix as string).replace(/\d{8}:/gu, " ").trim().split(/\s+/u).map(Number);
  let theta = -Math.round(typeof entry.rotation === "number" ? entry.rotation : 0);
  theta -= 360 * Math.floor(theta / 360 + 0.9 / 360);
  const near = (angle: number): boolean => Math.abs(theta - angle) < 1;
  if (near(90)) return m[3]! > 0 ? { filter: "transpose=cclock_flip", transposed: true, x: false, y: false } : { filter: "transpose=clock", transposed: true, x: true, y: false };
  if (near(270)) return m[3]! < 0 ? { filter: "transpose=clock_flip", transposed: true, x: true, y: true } : { filter: "transpose=cclock", transposed: true, x: false, y: true };
  const x = near(180) && m[0]! < 0;
  const y = (near(180) || near(0)) && m[4]! < 0;
  return { filter: x || y ? [x ? "hflip" : "", y ? "vflip" : ""].filter((part) => part !== "").join(",") : null, transposed: false, x, y };
}

/**
 * The filters that take a source's decoded frames, which keep codec cropping only and are turned by FFmpeg's autorotate, to
 * the picture it shows: a non-square sample aspect ratio scaled to the size the source is filed at, with square pixels.
 * @param report - The source's probe.
 * @returns The filter chain text, or null when the decoded frames are the shown picture.
 * @throws {never} Never.
 */
export function shownFilters(report: ProbeReport): string | null {
  const video = realVideoStream(report);
  const { width, height } = pickMediaMetadata(report);
  return video?.sampleAspectRatio === undefined || width === null || height === null ? null : `scale=${width}:${height},setsar=1`;
}
