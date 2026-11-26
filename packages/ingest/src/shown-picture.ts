// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The picture a video source shows is FFmpeg's (frames-split design D07): its default decode applies the container crop (a
 * Matroska PixelCrop or an MP4 clean aperture) and the display matrix, and a non-square sample aspect ratio is scaled to the
 * size the source is filed at (`squareDisplay` in `@ingest/media-metadata.js`), the same size the frame-grid plan takes.
 */

import { pickMediaMetadata, realVideoStream, type ProbeReport } from "@ingest/media-metadata.js";

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
 * The filters that take a source's frames, as FFmpeg's default decode gives them, to the picture it shows: a non-square sample
 * aspect ratio scaled to the size the source is filed at, with square pixels.
 * @param report - The source's probe.
 * @returns The filter chain text, or null when the decoded frames are the shown picture.
 * @throws {never} Never.
 */
export function shownFilters(report: ProbeReport): string | null {
  const video = realVideoStream(report);
  const { width, height } = pickMediaMetadata(report);
  return video?.sampleAspectRatio === undefined || width === null || height === null ? null : `scale=${width}:${height},setsar=1`;
}
