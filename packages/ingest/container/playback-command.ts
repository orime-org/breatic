// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The playback command builder (frames-split design §4.3, §3.2, §7.1 reuse-carrier row): how a grid frame becomes a target
 * picture and how a target is encoded and muxed. Its source digest is part of the producer version, which the container build
 * embeds; the edit-file commands live in `edit-command.ts` so a change here never invalidates an edit file. Every picture
 * here is SDR: an HDR source always has an edit file, which is already BT.709.
 */
import { PACKED_PLANE_GAP, packedPlaneWidth } from '@shared/mini-tools/video-encode-plan.js';
import type { FrameRate } from '@shared/upload/frame-grid-rate.js';
import type { MiniToolPlanPixelRect, MiniToolPlanTarget } from '@shared/upload/mini-tool-plan-types.js';

/** The BT.709 limited-range tags every SDR output carries. */
export const BT709_TAGS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
/** Seconds between playback keyframes (`presentation.playback_gop_seconds`, §4.3 opaque row). */
export const PLAYBACK_GOP_SECONDS = 2;
// The plan's matrix names (physical-video-probe.ts) as the scale filter spells them.
const SCALE_MATRICES: Readonly<Record<string, string>> = { bt709: 'bt709', bt601: 'bt601', bt2020nc: 'bt2020', smpte240m: 'smpte240m', fcc: 'fcc' };
// The audio of every user-facing video output, at the bitrate the audio mini-tools write (src/jobs/op-args.ts AUDIO_OUT).
const AAC = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];

/** The format a decoded picture is converted to, and whether to limited-range BT.709. */
export interface PictureOutput { format: string; bt709?: boolean }

/**
 * The scale filter's name for a plan matrix.
 * @param matrix - The plan matrix.
 * @returns The scale filter's value.
 * @throws {RangeError} When the matrix has no decode value.
 */
export function scaleMatrix(matrix: string): string {
  const value = SCALE_MATRICES[matrix];
  if (value === undefined) throw new RangeError(`No decode matrix for ${matrix}`);
  return value;
}

/**
 * Decoded frames as a picture of a size (§4.3 colour row): decoded with the plan matrix and the source's range, scaled to the
 * display size with square pixels and converted to the output format.
 * @param matrix - The plan matrix.
 * @param range - The source's range.
 * @param width - The output width.
 * @param height - The output height.
 * @param output - The format and whether to limited-range BT.709.
 * @returns The filter chain text.
 * @throws {RangeError} When the matrix has no decode value.
 */
export function decodedPicture(matrix: string, range: 'tv' | 'pc', width: number, height: number, output: PictureOutput): string {
  const out = output.bt709 === true ? ':out_color_matrix=bt709:out_range=tv' : '';
  return `scale=${width}:${height}:in_color_matrix=${scaleMatrix(matrix)}:in_range=${range}${out},format=${output.format},setsar=1`;
}

/**
 * Where the picture sits in the coded frame: the display rectangle, or the whole frame (one plane when alpha is packed).
 * @param target - The target.
 * @returns The picture rectangle and the plane width.
 * @throws {never} Never.
 */
export function placement(target: MiniToolPlanTarget): { rect: MiniToolPlanPixelRect; planeWidth: number } {
  const planeWidth = target.alpha === 'packed' ? packedPlaneWidth(target.width) : target.width;
  return { rect: target.displayRect ?? { x: 0, y: 0, width: planeWidth, height: target.height }, planeWidth };
}

/**
 * The filters that turn decoded grid frames into the target picture (§4.3, §3.5): decoded with the plan matrix, scaled to the
 * picture rectangle and padded to the coded size; a packed carrier is premultiplied colour, the `PACKED_PLANE_GAP` columns,
 * then alpha; a VP9 split output keeps its size and straight alpha.
 * @param target - The target.
 * @param range - The source's range.
 * @param label - A label prefix unique within the graph.
 * @returns The filter chain text.
 * @throws {RangeError} When the plan matrix has no decode value.
 */
export function picture(target: MiniToolPlanTarget, range: 'tv' | 'pc', label: string): string {
  const { rect, planeWidth } = placement(target);
  const head = (output: PictureOutput): string => decodedPicture(target.colorMatrix, range, rect.width, rect.height, output);
  const pad = `pad=${planeWidth}:${target.height}:${rect.x}:${rect.y}:color=black`;
  // A display matrix left on the frames would be written to the output and turn it again.
  const upright = `${BT709_TAGS},sidedata=mode=delete:type=DISPLAYMATRIX`;
  if (target.format === 'webm-vp9') {
    const straight = target.alpha === 'straight';
    const format = straight ? 'yuva420p' : 'yuv420p';
    if (target.displayRect === null) return `${head({ format, bt709: true })},${upright}`;
    return `${head({ format: straight ? 'yuva444p' : 'yuv444p', bt709: true })},pad=${target.width}:${target.height}:${rect.x}:${rect.y}:color=black${straight ? '@0' : ''},` +
      `format=${format},${upright}`;
  }
  const tail = `scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,${upright}`;
  // Unpadded, the picture goes to 4:2:0 in one conversion: a 4:4:4 round trip would resample the chroma twice.
  if (target.alpha === 'none' && target.displayRect === null && planeWidth === rect.width) return `${head({ format: 'yuv420p', bt709: true })},${upright}`;
  if (target.alpha === 'none') return `${head({ format: 'yuv444p', bt709: true })},${pad},${tail}`;
  const below = target.height - rect.y - rect.height;
  const colourPlane = `${pad},fillborders=left=${rect.x}:right=${planeWidth - rect.x - rect.width}:top=${rect.y}:bottom=${below}:mode=smear,` +
    `pad=${planeWidth + 2}:${target.height}:0:0,fillborders=right=2:mode=smear,pad=${planeWidth + PACKED_PLANE_GAP}:${target.height}:0:0:color=black`;
  return `${head({ format: 'gbrap' })},split=2[${label}r][${label}a];[${label}r]premultiply=inplace=1,format=gbrp,${colourPlane},format=rgb24[${label}c];` +
    `[${label}a]alphaextract,format=rgb24,${pad}[${label}m];[${label}c][${label}m]hstack,${tail}`;
}

/**
 * The encoder and muxer of a target on the grid (§4.3 opaque row): one frame per 1/fps from 0, no B-frames, H.264 MP4 with
 * a keyframe every `PLAYBACK_GOP_SECONDS`, or a VP9 WebM split output with its alpha.
 * @param target - The target.
 * @param fps - The grid rate the frames are on.
 * @returns The encoder arguments and the muxer arguments.
 * @throws {never} Never.
 */
export function videoOutput(target: Pick<MiniToolPlanTarget, 'format' | 'alpha' | 'crf' | 'preset'>, fps: FrameRate): { video: string[]; muxer: string[] } {
  const timing = ['-fps_mode', 'passthrough', '-enc_time_base:v', `${fps.denominator}/${fps.numerator}`, '-bsf:v', 'setts=duration=1'];
  if (target.format === 'webm-vp9') {
    const alpha = target.alpha === 'straight';
    return { video: ['-c:v', 'libvpx-vp9', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-crf', String(target.crf), '-b:v', '0', '-deadline', 'good', '-row-mt', '1',
      ...(alpha ? ['-auto-alt-ref', '0'] : []), ...timing], muxer: ['-f', 'webm'] };
  }
  const gop = Math.max(1, Math.round((PLAYBACK_GOP_SECONDS * fps.numerator) / fps.denominator));
  return { video: ['-c:v', 'libx264', '-preset', target.preset, '-crf', String(target.crf), '-bf', '0', '-g', String(gop), '-pix_fmt', 'yuv420p', ...timing],
    muxer: ['-movflags', '+faststart', '-f', 'mp4'] };
}

/**
 * The audio encoder of a target, mapping `[a]`: AAC 48 kHz in MP4, Opus in a VP9 WebM split output (§4.4, §7.17 segment row).
 * @param target - The target.
 * @returns The audio arguments.
 * @throws {never} Never.
 */
export function audioOutput(target: Pick<MiniToolPlanTarget, 'format'>): string[] {
  return target.format === 'webm-vp9' ? ['-map', '[a]', '-c:a', 'libopus', '-ar', '48000'] : ['-map', '[a]', ...AAC];
}
