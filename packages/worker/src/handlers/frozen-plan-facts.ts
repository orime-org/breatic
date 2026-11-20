// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plan facts the worker's recipes need and its frozen inputs do not carry (inner#1306 frames-split design §3.2 item 2
 * `color.matrix`, `color.toneMap`, `framePngBitDepth`; §7.17: every recipe is written from the frozen plan's grid and colour).
 *
 * The plan's colour facts every recipe target names (§7.17 方向与几何 row: frames and segments convert by the plan's matrix).
 *
 * ponytail: a frozen run holds only the selected version (`VideoPresentationVersion`), which carries the plan's digest but
 * not its colour or PNG depth, so no recipe target can be built from it yet; every builder fails its step here until the
 * shared version schema (or the frozen execution) carries them. Kept in one module so each gap has one place to close.
 */

import type {
  FrameRate, MiniToolPlanJobReport, MiniToolPlanRecipe, VideoPresentationChunkUnit, VideoPresentationPrepareAnswer, VideoPresentationVersion,
} from '@breatic/shared';
import { MiniToolStepFailed } from '@worker/handlers/mini-tool/step-failed.js';

/** The colour conversion and frame depth a version's plan decided. */
export interface PlanColor { colorMatrix: string; toneMap: 'none' | 'sdr-bt709'; pngBitDepth: 8 | 16 }

/**
 * The plan colour of a frozen version.
 * @param version - The frozen selected version.
 * @throws {MiniToolStepFailed} With `presentation_color_unavailable`.
 */
export function planColorOf(version: VideoPresentationVersion): PlanColor {
  throw new MiniToolStepFailed(`presentation_color_unavailable:${version.planSha256}`);
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

/** One presentation unit's recipe, its source inputs and its output type. */
export interface PresentationUnitRecipe { recipe: MiniToolPlanRecipe; inputs: { inputId: string; storageKey: string }[]; contentType: string }

/**
 * The recipe of one presentation unit (§7.17 grid_count, edit_encode, chunk_encode and stitch rows), the source inputs it
 * binds besides its chunks (a stitch's chunks are bound under `chunkInputId`) and the type its output is written as.
 * ponytail: the prepare answer carries the route, stages, chunk windows and frozen carrier encode but not the plan's grid
 * (fps, grid start and end), the counted frames, the display geometry, the plan's colour, the probe's colour inputs, the
 * source keyframe statistics or the edit tier, so no unit recipe can be built yet.
 * @param answer - The DO's prepare answer.
 * @param unit - The unit.
 * @param sourceKey - The original's storage key.
 * @throws {PresentationFactsUnavailable} Always.
 */
export function presentationRecipeOf(answer: VideoPresentationPrepareAnswer, unit: VideoPresentationChunkUnit, sourceKey: string): PresentationUnitRecipe {
  throw new PresentationFactsUnavailable(`${unit.kind}:${answer.plan?.planSha256 ?? 'none'}:${sourceKey}`);
}

/**
 * The count a done `grid_count` job measured (§4.1 frame count row): the last real frame's display time and the decoded
 * frames, which the count unit's Done report carries.
 * ponytail: the job report schema carries written objects only, so a count job's measurement has no field to arrive in.
 * @param report - The done job report.
 * @throws {PresentationFactsUnavailable} Always.
 */
export function gridCountOf(report: Extract<MiniToolPlanJobReport, { state: 'done' }>): { lastVideoTime: FrameRate; sourceFrames: number } {
  throw new PresentationFactsUnavailable(`count:${report.outputs.length}`);
}
