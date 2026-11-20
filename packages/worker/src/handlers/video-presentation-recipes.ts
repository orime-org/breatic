// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Container recipes read from a frozen selected version on the frame grid (inner#1306 frames-split design §7.16, §7.17).
 *
 * Every recipe names grid frames of the version's tool source: the edit file when the version has one, else the original
 * with its source keyframe statistics; the container converts frame numbers to read positions itself (§7.16), so the
 * worker builds no frame table.
 */

import type {
  MiniToolPlanChunkRef, MiniToolPlanDetectorProfile, MiniToolPlanFrameCrop, MiniToolPlanFrameTarget, MiniToolPlanFrames, MiniToolPlanGrid, MiniToolPlanRecipe,
  MiniToolPlanTarget, MiniToolPlanToolSource, VideoPresentationVersion,
} from '@breatic/shared';
import { planColorOf } from '@worker/handlers/frozen-plan-facts.js';

/** A single-source stitch (§7.17 stitch row). */
type MiniToolPlanStitch = Extract<MiniToolPlanRecipe, { kind: 'stitch'; inputId: string; target: MiniToolPlanTarget }>;

/** A half-open grid frame window. */
export interface FrameWindow { start: number; end: number }

/** The fixed input id of a run's tool source in every job it sends. */
export const SOURCE_INPUT_ID = '00000000-0000-4000-8000-000000000001';
/** The fixed input id of the original, read for its audio when the frames come from the edit file (§4.4). */
export const AUDIO_INPUT_ID = '00000000-0000-4000-8000-000000000002';

/**
 * The input id of chunk n of a stitch.
 * @param chunk - The chunk.
 * @returns Its input id.
 * @throws {never} Never.
 */
export function chunkInputId(chunk: number): string {
  return `00000000-0000-4000-8001-${String(chunk).padStart(12, '0')}`;
}

/** A recipe's frozen tool source: the job inputs it reads, its grid and its source kind. */
export interface ToolInput {
  /** The tool source first, then the original when the frames come from the edit file. */
  inputs: { inputId: string; storageKey: string }[];
  /** The id the tool source is bound under. */
  inputId: string;
  grid: MiniToolPlanGrid;
  source: MiniToolPlanToolSource;
  /** Present when the frames come from the edit file: the original the audio is read from (§4.4). */
  audioInputId?: string;
}

/**
 * A version's display grid as a recipe names it.
 * @param version - The frozen selected version.
 * @returns The grid.
 * @throws {never} Never.
 */
export function gridOf(version: VideoPresentationVersion): MiniToolPlanGrid {
  const { display } = version;
  return { fps: display.fps, gridStart: display.gridStart, frameCount: display.frameCount, realFrameCount: display.realFrameCount };
}

/**
 * The original as a tool source with its source keyframe statistics (§7.16 original row).
 * @param version - The frozen selected version.
 * @param sourceKey - The original's storage key.
 * @param inputId - The id it is bound under.
 * @returns The tool input.
 * @throws {never} Never.
 */
export function originalInputOf(version: VideoPresentationVersion, sourceKey: string, inputId = SOURCE_INPUT_ID): ToolInput {
  return { inputs: [{ inputId, storageKey: sourceKey }], inputId, grid: gridOf(version), source: { kind: 'original', keyframes: version.toolSource.keyframes } };
}

/**
 * The tool source a version's recipes read (§7.16): the edit file when it has one, with the original beside it for audio,
 * else the original and its source keyframe statistics; the grid is the version's display grid.
 * @param version - The frozen selected version.
 * @param sourceKey - The original's storage key.
 * @param inputId - The id the tool source is bound under.
 * @param audioInputId - The id the original is bound under beside an edit file.
 * @returns The tool input.
 * @throws {never} Never.
 */
export function toolInputOf(version: VideoPresentationVersion, sourceKey: string, inputId = SOURCE_INPUT_ID, audioInputId = AUDIO_INPUT_ID): ToolInput {
  const { edit } = version.toolSource;
  if (edit === null) return originalInputOf(version, sourceKey, inputId);
  return { inputs: [{ inputId, storageKey: edit.storageKey }, { inputId: audioInputId, storageKey: sourceKey }], inputId,
    grid: gridOf(version), source: { kind: 'edit' }, audioInputId };
}

/**
 * The audio reference of a single-source output (§4.4): the original's audio, named beside an edit file.
 * @param input - The tool input.
 * @returns The audio fields.
 * @throws {never} Never.
 */
export function audioRefOf(input: ToolInput): { audio: true; audioInputId?: string } {
  return { audio: true, ...(input.audioInputId === undefined ? {} : { audioInputId: input.audioInputId }) };
}

/**
 * The window fields of a recipe over grid frames of a tool source.
 * @param input - The tool input.
 * @param frames - The grid frames.
 * @param target - The target.
 * @returns The fields.
 * @throws {never} Never.
 */
export function windowOf<T extends MiniToolPlanTarget>(input: ToolInput, frames: FrameWindow, target: T): { inputId: string; grid: MiniToolPlanGrid; source: MiniToolPlanToolSource; frames: MiniToolPlanFrames; target: T } {
  return { inputId: input.inputId, grid: input.grid, source: input.source, frames: { start: frames.start, end: frames.end }, target };
}

/**
 * The chunk references of a stitch, in the order given.
 * @param windows - Each chunk's grid frames.
 * @returns The references.
 * @throws {never} Never.
 */
export function chunkRefsOf(windows: readonly FrameWindow[]): MiniToolPlanChunkRef[] {
  return windows.map((window, chunk) => ({ inputId: chunkInputId(chunk), frames: { start: window.start, end: window.end } }));
}

/**
 * A stitch of a single-source output's chunks (§5.4, §7.17 stitch row): with the original's audio over the grid, or none.
 * @param input - The tool input.
 * @param windows - Each chunk's grid frames, in order.
 * @param target - The target.
 * @param audio - Whether the original's audio is laid under it.
 * @returns The recipe.
 * @throws {never} Never.
 */
export function stitchOf(input: ToolInput, windows: readonly FrameWindow[], target: MiniToolPlanTarget, audio: boolean): MiniToolPlanStitch {
  // The stitch reads the original for its audio over the grid (§4.4).
  return { kind: 'stitch', inputId: audio ? input.audioInputId ?? input.inputId : input.inputId, grid: input.grid, target, audio, chunks: chunkRefsOf(windows) };
}

/**
 * Whether a version presents with transparency.
 * @param version - The version.
 * @returns True for an alpha-packed version.
 * @throws {never} Never.
 */
export function transparent(version: VideoPresentationVersion): boolean {
  return version.playback.kind === 'alpha-packed';
}

/**
 * An H.264 side (§4.3 odd size row): an odd side rounds down to even, a side of 1 becomes 2.
 * @param side - The display side.
 * @returns The coded side.
 * @throws {never} Never.
 */
export function evenSide(side: number): number {
  return side === 1 ? 2 : side - (side % 2);
}

/** A split output's target: its container and codec follow its transparency (§7.17 segment row). */
export type SegmentTarget = MiniToolPlanTarget & { format: 'mp4-h264' | 'webm-vp9' };

/**
 * A video target at the display size with the frozen encode (§7.17 segment row): opaque H.264 on even sides, transparent
 * VP9 at the display size.
 * @param version - The frozen selected version.
 * @param encode - The frozen crf and preset.
 * @param encode.crf - The crf.
 * @param encode.preset - The preset.
 * @returns The target.
 * @throws {never} Never.
 */
export function segmentTarget(version: VideoPresentationVersion, encode: { crf: number; preset: MiniToolPlanTarget['preset'] }): SegmentTarget {
  const { colorMatrix, toneMap } = planColorOf(version);
  const { width, height } = version.display;
  if (transparent(version)) return { width, height, displayRect: null, colorMatrix, toneMap, alpha: 'straight', crf: encode.crf, preset: encode.preset, format: 'webm-vp9' };
  return { width: evenSide(width), height: evenSide(height), displayRect: null, colorMatrix, toneMap, alpha: 'none', crf: encode.crf, preset: encode.preset, format: 'mp4-h264' };
}

/**
 * A still's PNG target: display geometry, the plan's colour and depth, straight alpha for a transparent version.
 * @param version - The frozen selected version.
 * @returns The target.
 * @throws {never} Never.
 */
export function frameTarget(version: VideoPresentationVersion): MiniToolPlanFrameTarget {
  const { colorMatrix, toneMap, pngBitDepth } = planColorOf(version);
  return { width: version.display.width, height: version.display.height, colorMatrix, toneMap, pngBitDepth, alpha: transparent(version) ? 'straight' : 'none' };
}

/**
 * One grid frame's PNG (§7.17 frame row), cropped in the display geometry when a crop is given (the video focus crop, §5.5).
 * @param version - The frozen selected version.
 * @param input - The tool input it reads.
 * @param frameIndex - The grid frame.
 * @param crop - The crop rectangle in P.display, if any.
 * @returns The recipe and the input it reads.
 * @throws {never} Never.
 */
export function frameRecipeOf(version: VideoPresentationVersion, input: ToolInput, frameIndex: number, crop?: MiniToolPlanFrameCrop['rect']): { recipe: MiniToolPlanRecipe; inputs: ToolInput['inputs'] } {
  const { width, height } = version.display;
  return { inputs: input.inputs.slice(0, 1), recipe: { kind: 'frame', inputId: input.inputId, grid: input.grid, source: input.source, frameIndex, target: frameTarget(version),
    ...(crop === undefined ? {} : { crop: { sourceWidth: width, sourceHeight: height, rect: crop } }) } };
}

/**
 * The scene detector over a range of grid frames.
 * @param version - The frozen selected version.
 * @param input - The tool input it reads.
 * @param frames - The range.
 * @param profile - The frozen detector profile.
 * @returns The recipe.
 * @throws {never} Never.
 */
export function sceneCutsRecipeOf(version: VideoPresentationVersion, input: ToolInput, frames: MiniToolPlanFrames, profile: MiniToolPlanDetectorProfile): MiniToolPlanRecipe {
  const { colorMatrix, toneMap } = planColorOf(version);
  return { kind: 'scene_cuts', inputId: input.inputId, grid: input.grid, source: input.source, frames: { start: frames.start, end: frames.end },
    profile, target: { width: version.display.width, height: version.display.height, colorMatrix, toneMap } };
}

/**
 * A split segment over grid frames (§7.17 segment row): one segment recipe when it is not chunked, else one chunk_encode per
 * frozen window and the stitch joining them with the original's audio over the grid.
 * @param version - The frozen selected version.
 * @param sourceKey - The original's storage key.
 * @param range - The segment's grid frames.
 * @param encode - The frozen crf and preset.
 * @param encode.crf - The crf.
 * @param encode.preset - The preset.
 * @param windows - The frozen chunk windows; one window covering the range means no chunks.
 * @returns The recipes (the segment alone, or the chunks then the stitch) and the inputs every one reads.
 * @throws {never} Never.
 */
export function segmentRecipesOf(version: VideoPresentationVersion, sourceKey: string, range: FrameWindow, encode: { crf: number; preset: MiniToolPlanTarget['preset'] },
  windows: readonly FrameWindow[]): { recipes: MiniToolPlanRecipe[]; inputs: ToolInput['inputs'] } {
  const input = toolInputOf(version, sourceKey);
  const target = segmentTarget(version, encode);
  if (windows.length <= 1) return { inputs: input.inputs, recipes: [{ kind: 'segment', ...windowOf(input, range, target), ...audioRefOf(input) }] };
  const chunks: MiniToolPlanRecipe[] = windows.map((window) => ({ kind: 'chunk_encode', ...windowOf(input, window, target) }));
  return { inputs: input.inputs, recipes: [...chunks, stitchOf(input, windows, target, true)] };
}
