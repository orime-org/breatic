// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The picture a video source shows, as Chromium shows it: a Matroska PixelCrop is applied (Chromium's
 * `media/formats/webm/webm_video_client.cc` reads it into the visible rectangle) and an MP4 clean aperture is not (its
 * `media/formats/mp4/box_definitions.cc` has no clap). ffprobe reports both as the stream's Frame Cropping side data, and
 * FFmpeg's decoders apply both, rounded to the chroma grid, so every decode of a source keeps codec cropping only
 * (`CODEC_CROPPING_ONLY`) and crops a PixelCrop exactly itself.
 */

/** The pixels a container crops at each edge of a picture. */
export interface ContainerCrop { top: number; bottom: number; left: number; right: number }
export const NO_CONTAINER_CROP: ContainerCrop = { top: 0, bottom: 0, left: 0, right: 0 };

/** The decoder input options that apply codec cropping and no container cropping. */
export const CODEC_CROPPING_ONLY: readonly string[] = ["-apply_cropping", "codec"];

/** One entry of a stream's ffprobe side data, as far as the picture's crop and turn read it. */
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
 * A Matroska stream's PixelCrop, in its stored orientation; null for any other container and for a crop of nothing.
 * @param side - The stream's side data.
 * @param formatName - The ffprobe format name.
 * @returns The crop, or null.
 * @throws {TypeError} When a cropping value is malformed.
 */
export function matroskaCrop(side: readonly PictureSideData[] | undefined, formatName: string): ContainerCrop | null {
  if (!formatName.split(",").includes("matroska")) return null;
  const entry = side?.find((item) => item.side_data_type === "Frame Cropping");
  if (entry === undefined) return null;
  const value = (key: string): number => {
    const found = entry[key] ?? 0;
    if (typeof found !== "number" || !Number.isSafeInteger(found) || found < 0) throw new TypeError("Expected a container cropping value");
    return found;
  };
  const crop = { top: value("crop_top"), bottom: value("crop_bottom"), left: value("crop_left"), right: value("crop_right") };
  return crop.top + crop.bottom + crop.left + crop.right === 0 ? null : crop;
}

/**
 * A stored crop in the orientation FFmpeg's autorotate shows the picture at.
 * @param crop - The crop of the stored picture.
 * @param turn - The turn.
 * @returns The crop of the shown picture.
 * @throws {never} Never.
 */
export function shownCrop(crop: ContainerCrop, turn: DisplayTurn): ContainerCrop {
  const [left, right, top, bottom] = turn.transposed ? [crop.top, crop.bottom, crop.left, crop.right] : [crop.left, crop.right, crop.top, crop.bottom];
  return { left: turn.x ? right : left, right: turn.x ? left : right, top: turn.y ? bottom : top, bottom: turn.y ? top : bottom };
}

/**
 * The filters that crop a shown picture exactly: on full-chroma frames, where an odd edge cuts no chroma sample in two.
 * @param crop - The crop of the shown picture.
 * @returns The filter chain text.
 * @throws {never} Never.
 */
export function exactCrop(crop: ContainerCrop): string {
  return `format=pix_fmts=yuva444p16le|yuv444p16le,crop=iw-${crop.left}-${crop.right}:ih-${crop.top}-${crop.bottom}:${crop.left}:${crop.top}:exact=1`;
}
