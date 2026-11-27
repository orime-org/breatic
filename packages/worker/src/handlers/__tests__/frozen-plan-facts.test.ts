// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The plan facts the worker writes recipes from (inner#1306 frames-split design §3.2 items 2 and 6, §5.1 2a row, §7.17).
 *
 * A frozen version carries its plan, so a recipe's colour and PNG depth come from it; a tool reading the edit file reads the
 * edit file's own SDR BT.709 picture when the plan tone maps (§4.2 HDR row). The presentation DO's prepare answer carries the
 * plan, the candidate grid and the probe facts, from which each unit's recipe is written: grid_count from the plan's grid
 * rule inputs, edit_encode at the edit tier with the probe's colour inputs and the frozen edit encode, chunk_encode and the
 * stitch at the carrier geometry with the frozen carrier encode, reading the edit file on the edit routes. A done grid count
 * job reports its count.
 */

import { describe, expect, it } from 'vitest';
import { miniToolPlanJobRequestSchema, videoPresentationPrepareAnswerSchema, type MiniToolPlanJobReport, type VideoPresentationChunkUnit, type VideoPresentationPrepareAnswer } from '@breatic/shared';
import { videoCarrierRouteStages } from '@breatic/shared/mini-tools';
import { gridCountOf, planColorOf, presentationRecipeOf, PresentationFactsUnavailable } from '@worker/handlers/frozen-plan-facts.js';
import { AUDIO_INPUT_ID, chunkInputId, SOURCE_INPUT_ID } from '@worker/handlers/video-presentation-recipes.js';
import { frozenVersion } from '../mini-tool/__tests__/frozen-presentation.js';

const KEY = 'video/canonical.webm';
const EDIT_KEY = 'video/canonical.webm.edit.mp4';
const PRICE = { containerClass: 'MiniToolContainerStd4', size: { vcpu: 4, memory_gib: 12, disk_gb: 20 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } };
const R = (numerator: number, denominator = 1): { numerator: number; denominator: number } => ({ numerator, denominator });
// A 95x63 opaque original at 30000/1001 fps from 1/100 s, 60 grid frames of which 58 real, with audio up to 2 s.
const CONTENT = {
  gridRulesVersion: 1, grid: { fps: R(30000, 1001), gridStart: R(1, 100), leadFrames: 0, gridEnd: R(2), singleFrameDurationMs: 5000 },
  toolSource: 'original', audioTrack: 0, display: { width: 95, height: 63 }, color: { matrix: 'bt601', toneMap: 'none' }, framePngBitDepth: 8,
};
const DISPLAY = { width: 95, height: 63, fps: R(30000, 1001), frameCount: 60, gridStart: R(1, 100), realFrameCount: 58, leadFrames: 0, holdFrames: 2 };
const GRID = { fps: R(30000, 1001), gridStart: R(1, 100), frameCount: 60, realFrameCount: 58 };
const KEYFRAMES = { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false };
const COLOR = { matrix: 'bt601', transfer: 'bt709', primaries: 'bt470bg', range: 'tv', chromaLocation: 'left' };
const CHUNKS = [{ start: 0, end: 30 }, { start: 30, end: 60 }];
const EDIT_CHUNKS = [{ start: 0, end: 20 }, { start: 20, end: 40 }, { start: 40, end: 60 }];

/**
 * A granted prepare answer as the shared schema parses it.
 * @param route - The route.
 * @param change - Plan fields that differ.
 * @returns The answer.
 */
function answerOf(route: 'encode' | 'edit' | 'reuse_edit', change: Record<string, unknown> = {}): VideoPresentationPrepareAnswer {
  const edit = route !== 'encode';
  return videoPresentationPrepareAnswerSchema.parse({
    sourceBinding: { storageKey: KEY, sourceFingerprint: 'a'.repeat(64) }, presentation: null,
    preparation: { targetPolicyVersion: 1, jobId: 'job-a', stage: 'plan', failure: null },
    capability: { token: 'token-a', deadlineAt: 1_900_000_000_000 },
    plan: {
      route, stages: videoCarrierRouteStages(route), toolInputId: route === 'edit' ? null : 'c'.repeat(64), planSha256: 'd'.repeat(64),
      content: { ...CONTENT, toolSource: edit ? 'edit' : 'original' }, display: DISPLAY,
      source: { color: COLOR, keyframes: KEYFRAMES, editTier: edit ? 'edit_h264_intra_8bit_420' : null, alpha: false },
      editStorageKey: route === 'reuse_edit' ? EDIT_KEY : null, ...change,
    },
    work: route === 'edit' ? { kind: 'edit', editChunks: EDIT_CHUNKS, chunks: CHUNKS } : { kind: 'encode', chunks: CHUNKS },
    units: {},
    frozen: { pricing: { basic: PRICE, standard4: PRICE }, actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
      carrier: { crf: 20, preset: 'fast', maxShortSide: 1080 }, edit: { crf: 12, preset: 'slow' } },
  });
}

/**
 * The job request a unit's recipe forms, checked by the shared request schema the ingest Worker parses.
 * @param answer - The answer.
 * @param unit - The unit.
 * @returns The recipe and its parse verdict.
 */
function requestOf(answer: VideoPresentationPrepareAnswer, unit: VideoPresentationChunkUnit): { recipe: unknown; inputs: unknown; contentType: string | null; valid: boolean } {
  const { recipe, inputs, contentType } = presentationRecipeOf(answer, unit, KEY);
  const chunks = unit.kind === 'presentation-stitch' ? CHUNKS : unit.kind === 'presentation-edit-stitch' ? EDIT_CHUNKS : [];
  const base = { schemaVersion: 2, jobId: 'job', containerClass: 'MiniToolContainerStd4', deadlineAt: 1, limits: { probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
    inputs: [...inputs, ...chunks.map((_window, chunk) => ({ inputId: chunkInputId(chunk), storageKey: `${KEY}.chunk${chunk}` }))] };
  const request = recipe.kind === 'grid_count' ? { ...base, outputs: [], count: recipe }
    : { ...base, outputs: [{ outputIndex: 0, storageKey: `${KEY}.out`, contentType: contentType ?? 'none', recipe }] };
  return { recipe, inputs, contentType, valid: miniToolPlanJobRequestSchema.safeParse(request).success };
}

describe('planColorOf reads the frozen version\'s plan (§3.2 item 2, §4.2 HDR row)', () => {
  it('FC01 an SDR plan: its matrix, no tone map and its PNG depth', () => {
    expect(planColorOf(frozenVersion({ color: { matrix: 'bt601', toneMap: 'none' }, framePngBitDepth: 16 }))).toEqual({ colorMatrix: 'bt601', toneMap: 'none', pngBitDepth: 16 });
  });

  it('FC02 a tone-mapped plan reads its edit file\'s SDR BT.709 picture', () => {
    expect(planColorOf(frozenVersion({ editKey: EDIT_KEY, color: { matrix: 'bt2020nc', toneMap: 'sdr-bt709' } }))).toEqual({ colorMatrix: 'bt709', toneMap: 'sdr-bt709', pngBitDepth: 8 });
  });
});

describe('presentationRecipeOf writes each unit from the prepare answer (§5.1 2a row, §7.17)', () => {
  it('RC01 grid_count: the original, the plan\'s grid start, rate and end; no output type', () => {
    const made = requestOf(answerOf('encode'), { kind: 'presentation-count' });
    expect(made).toEqual({ recipe: { kind: 'grid_count', inputId: SOURCE_INPUT_ID, gridStart: R(1, 100), fps: R(30000, 1001), gridEnd: R(2) },
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: KEY }], contentType: null, valid: true });
  });

  it('RC02 edit_encode: an edit window of the original at the tier, the frozen edit encode, the probe\'s colour inputs and the plan\'s tone map', () => {
    const made = requestOf(answerOf('edit'), { kind: 'presentation-edit', chunk: 1 });
    expect(made).toEqual({ recipe: { kind: 'edit_encode', inputId: SOURCE_INPUT_ID, grid: GRID, source: { kind: 'original', keyframes: KEYFRAMES }, frames: EDIT_CHUNKS[1],
      edit: { profile: 'edit_h264_intra_8bit_420', crf: 12, preset: 'slow' }, color: COLOR, toneMap: 'none' },
    inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: KEY }], contentType: 'video/mp4', valid: true });
  });

  it('RC03 the edit stitch joins the edit chunks at the tier; a ProRes tier writes a MOV', () => {
    expect(requestOf(answerOf('edit'), { kind: 'presentation-edit-stitch' })).toEqual({
      recipe: { kind: 'stitch', grid: GRID, edit: { profile: 'edit_h264_intra_8bit_420' }, chunks: EDIT_CHUNKS.map((frames, chunk) => ({ inputId: chunkInputId(chunk), frames })) },
      inputs: [], contentType: 'video/mp4', valid: true });
    const prores = answerOf('edit', { source: { color: COLOR, keyframes: KEYFRAMES, editTier: 'edit_prores', alpha: true } });
    expect(requestOf(prores, { kind: 'presentation-edit-stitch' })).toMatchObject({ contentType: 'video/quicktime', valid: true });
    expect(requestOf(prores, { kind: 'presentation-edit', chunk: 0 })).toMatchObject({ contentType: 'video/quicktime', valid: true });
  });

  it('RC04 chunk_encode on the encode route: the original with its keyframes, at the carrier geometry padded to even and the frozen carrier encode', () => {
    expect(requestOf(answerOf('encode'), { kind: 'presentation-chunk', chunk: 1 })).toEqual({
      recipe: { kind: 'chunk_encode', inputId: SOURCE_INPUT_ID, grid: GRID, source: { kind: 'original', keyframes: KEYFRAMES }, frames: CHUNKS[1],
        target: { width: 96, height: 64, displayRect: { x: 0, y: 0, width: 95, height: 63 }, colorMatrix: 'bt601', toneMap: 'none', alpha: 'none', crf: 20, preset: 'fast' } },
      inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: KEY }], contentType: 'video/mp4', valid: true });
  });

  it('RC05 a transparent source encodes an alpha-packed carrier: two planes and the gap', () => {
    const made = requestOf(answerOf('encode', { source: { color: COLOR, keyframes: KEYFRAMES, editTier: null, alpha: true } }), { kind: 'presentation-chunk', chunk: 0 });
    expect(made).toMatchObject({ recipe: { target: { width: 96 * 2 + 4, height: 64, displayRect: { x: 0, y: 0, width: 95, height: 63 }, alpha: 'packed' } }, valid: true });
  });

  it.each([['edit', EDIT_KEY], ['reuse_edit', EDIT_KEY]] as const)('RC06 chunk_encode on the %s route reads the edit file the answer names', (route, key) => {
    const answer = answerOf(route, { editStorageKey: key });
    expect(requestOf(answer, { kind: 'presentation-chunk', chunk: 0 })).toMatchObject({
      recipe: { kind: 'chunk_encode', inputId: SOURCE_INPUT_ID, source: { kind: 'edit' }, frames: CHUNKS[0] }, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: key }], valid: true });
  });

  it('RC07 a tone-mapped plan\'s playback reads the edit file\'s BT.709 picture', () => {
    const answer = answerOf('edit', { editStorageKey: EDIT_KEY, content: { ...CONTENT, toolSource: 'edit', color: { matrix: 'bt2020nc', toneMap: 'sdr-bt709' } } });
    expect(requestOf(answer, { kind: 'presentation-chunk', chunk: 0 })).toMatchObject({ recipe: { target: { colorMatrix: 'bt709', toneMap: 'sdr-bt709' } }, valid: true });
  });

  it('RC08 the stitch joins the playback chunks with the original\'s audio over the grid when the plan selected a track', () => {
    const recipe = { kind: 'stitch', inputId: SOURCE_INPUT_ID, grid: GRID, audio: true, chunks: CHUNKS.map((frames, chunk) => ({ inputId: chunkInputId(chunk), frames })),
      target: { width: 96, height: 64, displayRect: { x: 0, y: 0, width: 95, height: 63 }, colorMatrix: 'bt601', toneMap: 'none', alpha: 'none', crf: 20, preset: 'fast' } };
    expect(requestOf(answerOf('encode'), { kind: 'presentation-stitch' })).toEqual({ recipe, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: KEY }], contentType: 'video/mp4', valid: true });
    const silent = answerOf('edit', { editStorageKey: EDIT_KEY, content: { ...CONTENT, toolSource: 'edit', audioTrack: null } });
    expect(requestOf(silent, { kind: 'presentation-stitch' })).toMatchObject({ recipe: { audio: false }, inputs: [{ inputId: SOURCE_INPUT_ID, storageKey: KEY }], valid: true });
    expect(AUDIO_INPUT_ID).not.toBe(SOURCE_INPUT_ID);
  });

  it.each([
    ['a chunk of the edit route before its edit file is written', answerOf('edit'), { kind: 'presentation-chunk', chunk: 0 }],
    ['a chunk past the work', answerOf('encode'), { kind: 'presentation-chunk', chunk: 2 }],
    ['an edit chunk of the encode route', answerOf('encode'), { kind: 'presentation-edit', chunk: 0 }],
    ['a job that was not granted', { ...answerOf('encode'), plan: null }, { kind: 'presentation-count' }],
  ] as const)('RC09 %s has no recipe', (_name, answer, unit) => {
    expect(() => presentationRecipeOf(answer as VideoPresentationPrepareAnswer, unit as VideoPresentationChunkUnit, KEY)).toThrow(PresentationFactsUnavailable);
  });
});

describe('gridCountOf reads a done count job\'s report (§4.1 frame count row, §7.17 grid_count)', () => {
  const done = (fields: Record<string, unknown> = {}): Extract<MiniToolPlanJobReport, { state: 'done' }> =>
    ({ schemaVersion: 2, state: 'done', outputs: [], usage: { wallMs: 1, cpuUsec: 1 }, ...fields });

  it('GC01 answers the count the job reported', () => {
    expect(gridCountOf(done({ count: { lastVideoTime: R(57, 30), sourceFrames: 58 } }))).toEqual({ lastVideoTime: R(57, 30), sourceFrames: 58 });
  });

  it('GC02 a report without a count has none to answer', () => {
    expect(() => gridCountOf(done())).toThrow(PresentationFactsUnavailable);
  });
});
