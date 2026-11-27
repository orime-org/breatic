// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The plan facts the worker's recipes are written from (inner#1306 frames-split design §3.2 items 2 and 6, §5.1 2a row,
 * §7.17: every recipe is written from the frozen plan's grid and colour).
 *
 * A frozen run reads the plan its selected version carries; a presentation job reads the plan, the candidate grid and the
 * probe facts the presentation DO's prepare answer carries. Both were adopted only under their digest (§3.2 item 6).
 */

import type {
  FrameRate, MiniToolPlanGrid, MiniToolPlanJobReport, MiniToolPlanRecipe, MiniToolPlanTarget, MiniToolPlanToolSource, VideoPresentationChunkUnit,
  VideoPresentationPlan, VideoPresentationPrepareAnswer, VideoPresentationVersion,
} from '@breatic/shared';
import { packedCarrierWidth, videoCarrierGeometry, type EditFileTier } from '@breatic/shared/mini-tools';
import { chunkRefsOf, SOURCE_INPUT_ID } from '@worker/handlers/video-presentation-recipes.js';

/** The colour conversion and frame depth a version's plan decided. */
export interface PlanColor { colorMatrix: string; toneMap: 'none' | 'sdr-bt709'; pngBitDepth: 8 | 16 }

/**
 * The matrix a recipe decodes its tool source with: a tone-mapping plan always has an edit file, which `edit_encode` wrote
 * as SDR BT.709 (§4.2 HDR row: every tool reads the edit file by its own SDR BT.709 tags); otherwise the plan's matrix.
 * @param plan - The plan.
 * @returns The colour fields a target names.
 * @throws {never} Never.
 */
function readColor(plan: VideoPresentationPlan): Pick<PlanColor, 'colorMatrix' | 'toneMap'> {
  return { colorMatrix: plan.color.toneMap === 'sdr-bt709' ? 'bt709' : plan.color.matrix, toneMap: plan.color.toneMap };
}

/**
 * The plan colour of a frozen version: the matrix its tool source is read with, the tone mapping and the frame PNG depth.
 * @param version - The frozen selected version.
 * @returns Its colour.
 * @throws {never} Never.
 */
export function planColorOf(version: VideoPresentationVersion): PlanColor {
  return { ...readColor(version.plan), pngBitDepth: version.plan.framePngBitDepth };
}

/** Why a presentation job's recipe or count cannot be formed from the DO's prepare answer. */
export class PresentationFactsUnavailable extends Error {
  /**
   * Name what is missing.
   * @param what - What is missing.
   * @throws {never} Never.
   */
  constructor(what: string) {
    super(`presentation_facts_unavailable:${what}`);
    this.name = 'PresentationFactsUnavailable';
  }
}

/**
 * One presentation unit's recipe, its source inputs and its output type; a grid count writes no output, so it has no type.
 */
export interface PresentationUnitRecipe { recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[]; contentType: string | null }

/**
 * The type an edit file of a tier is written as (§4.2): ProRes 4444 in MOV, every H.264 tier in MP4.
 * @param tier - The edit tier.
 * @returns The content type.
 * @throws {never} Never.
 */
function editContentType(tier: EditFileTier): string {
  return tier === 'edit_prores' ? 'video/quicktime' : 'video/mp4';
}

/**
 * A window of the answer's work.
 * @param windows - The windows.
 * @param chunk - The chunk index.
 * @param what - What the window is, for the failure.
 * @returns The window.
 * @throws {PresentationFactsUnavailable} When the work has no such window.
 */
function windowOf(windows: readonly { start: number; end: number }[], chunk: number, what: string): { start: number; end: number } {
  const window = windows[chunk];
  if (window === undefined) throw new PresentationFactsUnavailable(`${what}:${chunk}`);
  return { start: window.start, end: window.end };
}

/**
 * The recipe of one presentation unit (§7.17 grid_count, edit_encode, chunk_encode and stitch rows), the source inputs it
 * binds besides its chunks (a stitch's chunks are bound under `chunkInputId`) and the type its output is written as. Every
 * recipe is on the candidate's grid; the edit chunks read the original at the edit tier; the playback chunks read the edit
 * file on the edit routes and the original otherwise, at the carrier geometry (alpha-packed for a transparent source); the
 * stitch lays the original's audio over the grid when the plan selected a track.
 * @param answer - The DO's prepare answer.
 * @param unit - The unit.
 * @param sourceKey - The original's storage key.
 * @returns The recipe, its inputs and its output type.
 * @throws {PresentationFactsUnavailable} When the answer is not granted or lacks the window, edit tier or edit file the unit reads.
 */
export function presentationRecipeOf(answer: VideoPresentationPrepareAnswer, unit: VideoPresentationChunkUnit, sourceKey: string): PresentationUnitRecipe {
  const { plan, frozen, work } = answer;
  if (plan === null || frozen === null) throw new PresentationFactsUnavailable(`${unit.kind}:not_granted`);
  const { content, display, source } = plan;
  const original = [{ inputId: SOURCE_INPUT_ID, storageKey: sourceKey }];
  const grid: MiniToolPlanGrid = { fps: display.fps, gridStart: display.gridStart, frameCount: display.frameCount, realFrameCount: display.realFrameCount };
  const fromOriginal: MiniToolPlanToolSource = { kind: 'original', keyframes: source.keyframes };
  const chunks = work.kind === 'none' ? [] : work.chunks;
  const editChunks = work.kind === 'edit' ? work.editChunks : [];
  /**
   * The edit tier of an edit unit.
   * @returns The tier.
   * @throws {PresentationFactsUnavailable} When the plan has no edit file.
   */
  const tierOf = (): EditFileTier => {
    if (source.editTier === null) throw new PresentationFactsUnavailable(`${unit.kind}:edit_tier`);
    return source.editTier;
  };
  const geometry = videoCarrierGeometry(display, frozen.carrier.maxShortSide);
  const target: MiniToolPlanTarget = {
    width: source.alpha ? packedCarrierWidth(geometry.width) : geometry.width, height: geometry.height, displayRect: geometry.displayRect, ...readColor(content),
    alpha: source.alpha ? 'packed' : 'none', crf: frozen.carrier.crf, preset: frozen.carrier.preset,
  };
  switch (unit.kind) {
    case 'presentation-count': {
      const { gridStart, fps, gridEnd } = content.grid;
      return { recipe: { kind: 'grid_count', inputId: SOURCE_INPUT_ID, gridStart, fps, gridEnd }, inputs: original, contentType: null };
    }
    case 'presentation-edit': {
      const tier = tierOf();
      return { recipe: { kind: 'edit_encode', inputId: SOURCE_INPUT_ID, grid, source: fromOriginal, frames: windowOf(editChunks, unit.chunk, 'edit'),
        edit: { profile: tier, crf: frozen.edit.crf, preset: frozen.edit.preset }, color: source.color, toneMap: content.color.toneMap }, inputs: original, contentType: editContentType(tier) };
    }
    case 'presentation-edit-stitch': {
      const tier = tierOf();
      return { recipe: { kind: 'stitch', grid, edit: { profile: tier }, chunks: chunkRefsOf(editChunks) }, inputs: [], contentType: editContentType(tier) };
    }
    case 'presentation-chunk': {
      const frames = windowOf(chunks, unit.chunk, 'chunk');
      if (plan.route !== 'edit' && plan.route !== 'reuse_edit') {
        return { recipe: { kind: 'chunk_encode', inputId: SOURCE_INPUT_ID, grid, source: fromOriginal, frames, target }, inputs: original, contentType: 'video/mp4' };
      }
      if (plan.editStorageKey === null) throw new PresentationFactsUnavailable('presentation-chunk:edit_storage_key');
      return { recipe: { kind: 'chunk_encode', inputId: SOURCE_INPUT_ID, grid, source: { kind: 'edit' }, frames, target },
        inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: plan.editStorageKey }], contentType: 'video/mp4' };
    }
    case 'presentation-stitch':
      // The stitch reads the original for its audio over the grid (§4.4).
      return { recipe: { kind: 'stitch', inputId: SOURCE_INPUT_ID, grid, target, audio: content.audioTrack !== null, chunks: chunkRefsOf(chunks) }, inputs: original, contentType: 'video/mp4' };
  }
}

/**
 * The count a done `grid_count` job measured (§4.1 frame count row, §7.17 grid_count): the last real frame's display time
 * and the decoded frames, which the job report carries in place of an output.
 * @param report - The done job report.
 * @returns The count.
 * @throws {PresentationFactsUnavailable} When the report carries no count.
 */
export function gridCountOf(report: Extract<MiniToolPlanJobReport, { state: 'done' }>): { lastVideoTime: FrameRate; sourceFrames: number } {
  if (report.count === undefined) throw new PresentationFactsUnavailable(`count:${report.outputs.length}`);
  return report.count;
}
