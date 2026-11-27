// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 test plan §69 U01 (frames-split design §7.12, §10.6 "失败分类"): the panel is one pure derivation over four
 * states, `waiting-presentation`, `usable`, `retryable` and `unsupported`, taking the first of steps 1–4 that holds. There is
 * no frame table any more, so no `waiting-table` and no table read: a selected version P that the surface shows and whose
 * toolInputId the binding names is usable on its own. The response carries the selected bundle and the target policy's
 * preparation; it has no ledger. A multi-input panel shows its worst input.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as owner from '../use-canvas-video-bindings';

type State = 'waiting-presentation' | 'usable' | 'retryable' | 'unsupported';
const STATES: readonly string[] = ['waiting-presentation', 'usable', 'retryable', 'unsupported'];

/** The derivation input the design fixes (§7.12 last paragraph): toolInputId, candidate failure code, no table. */
interface Input {
  sourceURL: string;
  presentationStatus: 'loading' | 'ready' | 'failed';
  response: unknown;
  /** The version the surface currently shows (step 3). */
  resourceVersionId: string | null;
  /** The toolInputId of the binding the surface plays (step 4). */
  toolInputId: string | null;
  retrying: boolean;
}
const derive = (input: Input): string => (owner as unknown as { deriveVideoToolPanelState: (value: Input) => string }).deriveVideoToolPanelState(input);

const url = 'https://assets.example.test/video/source.mp4';
const VERSION = 'e'.repeat(64);
const TOOL_INPUT = 'd'.repeat(64);
const binding = { assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: 'a'.repeat(64), canonicalURL: url, kind: 'video', mediaInfo: { width: 1920, height: 1080, duration: 3, mimeType: 'video/mp4' } };
/** The selected bundle's grid display (§3.5 P descriptor, §4.1): 30 fps, 90 frames. */
const bundle = { schemaVersion: 1, versionId: VERSION, toolInputId: TOOL_INPUT, planSha256: 'f'.repeat(64),
  display: { width: 1920, height: 1080, fps: { numerator: 30, denominator: 1 }, frameCount: 90, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 90, leadFrames: 0, holdFrames: 0 } };

/**
 * A read in the new shape: binding, selected bundle and preparation, no ledger.
 * @param presentation - The selected bundle, or null.
 * @param failure - The target candidate's failure code, null while it runs; undefined for no preparation.
 * @returns The response.
 */
function read(presentation: typeof bundle | null, failure?: string | null): unknown {
  return { sourceBinding: binding, presentation, preparation: failure === undefined ? null : { targetPolicyVersion: 1, jobId: 'video-presentation:fixture', stage: failure === null ? 'encode' : null, failure } };
}

const usable: Input = { sourceURL: url, presentationStatus: 'ready', response: read(bundle), resourceVersionId: VERSION, toolInputId: TOOL_INPUT, retrying: false };
const unselected = (failure: string | null): Input => ({ ...usable, response: read(null, failure), resourceVersionId: null, toolInputId: null });

// §10.6 "失败分类": the temporary and content lists; a code on neither list is temporary.
const TEMPORARY = ['expired', 'presentation_failed', 'presentation_report_failed', 'cleanup_failed', 'admission_invalid', 'source_missing', 'invalid_limits', 'resource_exhausted', 'presentation_invalid', 'reuse_source_invalid', 'grid_mismatch'];
const CONTENT = ['classification_unknown', 'probe_invalid', 'source_over_cap', 'no_presented_frames', 'resource_limit', 'too_long', 'packed_over_cap', 'edit_over_cap'];
// Frame-table codes leave the content list with the table (§10.6 "伴随帧表的码随它删除"), so they fall to temporary.
const UNLISTED = ['invalid_edit', 'unsupported_rate', 'source_ledger_plan_mismatch', 'packed_clock_mismatch'];

describe('U01 the panel derivation over the frame grid (§7.12 steps 1–4)', () => {
  it('U01: step 4 is usable from P, its resource and the binding toolInputId alone, with no frame table read', () => {
    expect(derive(usable)).toBe('usable');
  });

  it('U01: step 4 with the binding naming another toolInputId is not usable', () => {
    const other = derive({ ...usable, toolInputId: 'b'.repeat(64) });
    expect(STATES).toContain(other);
    expect(other).not.toBe('usable');
  });

  it('U01: step 3 P selected but the surface shows no resource or another version waits for the presentation', () => {
    expect(derive({ ...usable, resourceVersionId: null })).toBe('waiting-presentation');
    expect(derive({ ...usable, resourceVersionId: 'c'.repeat(64) })).toBe('waiting-presentation');
  });

  it('U01: step 1 no current read for this source waits for the presentation', () => {
    expect(derive({ ...usable, presentationStatus: 'loading', response: undefined })).toBe('waiting-presentation');
    expect(derive({ ...usable, sourceURL: 'https://assets.example.test/video/other.mp4' })).toBe('waiting-presentation');
  });

  it('U01: step 1 a read that failed with no response held is retryable, and waits while its Retry rereads', () => {
    expect(derive({ ...usable, presentationStatus: 'failed', response: undefined })).toBe('retryable');
    expect(derive({ ...usable, presentationStatus: 'failed', response: undefined, retrying: true })).toBe('waiting-presentation');
  });

  it('U01: step 1 a reread that failed beside a held response keeps deriving from that response', () => {
    expect(derive({ ...usable, presentationStatus: 'failed' })).toBe('usable');
  });

  it('U01: step 2 nothing selected and the candidate not failed, or a retry pressed, waits for the presentation', () => {
    expect(derive({ ...usable, response: read(null), resourceVersionId: null, toolInputId: null })).toBe('waiting-presentation');
    expect(derive(unselected(null))).toBe('waiting-presentation');
    expect(derive({ ...unselected('expired'), retrying: true })).toBe('waiting-presentation');
  });

  it.each(TEMPORARY)('U01: step 2 a candidate failed with the temporary code %s is retryable', (code) => {
    expect(derive(unselected(code))).toBe('retryable');
  });

  it.each(CONTENT)('U01: step 2 a candidate failed with the content code %s is unsupported', (code) => {
    expect(derive(unselected(code))).toBe('unsupported');
  });

  it.each(UNLISTED)('U01: step 2 a code on neither list (%s, a deleted frame-table code) is temporary, so retryable', (code) => {
    expect(derive(unselected(code))).toBe('retryable');
  });

  it('U01: a target preparation in progress or failed beside a usable P leaves the panel usable', () => {
    for (const failure of [null, 'too_long', 'presentation_invalid']) expect(derive({ ...usable, response: { ...(read(bundle, failure) as object) } })).toBe('usable');
  });

  it('U01: the derivation only ever answers one of the four states (property)', () => {
    const code = fc.constantFrom(...TEMPORARY, ...CONTENT, ...UNLISTED);
    const input = fc.record({
      selected: fc.boolean(), failure: fc.option(code, { nil: null }), shown: fc.constantFrom<string | null>(VERSION, 'c'.repeat(64), null),
      toolInputId: fc.constantFrom<string | null>(TOOL_INPUT, 'b'.repeat(64), null), retrying: fc.boolean(), status: fc.constantFrom('loading' as const, 'ready' as const, 'failed' as const),
    });
    fc.assert(fc.property(input, (value) => {
      const state = derive({ sourceURL: url, presentationStatus: value.status, response: read(value.selected ? bundle : null, value.failure), resourceVersionId: value.shown, toolInputId: value.toolInputId, retrying: value.retrying });
      expect(STATES).toContain(state);
    }), { seed: 130669, numRuns: 200 });
  });
});

interface Ranked { state: State; reason: string | null }
const worst = (owner as unknown as { worstVideoToolPanelState: (inputs: readonly Ranked[]) => Ranked }).worstVideoToolPanelState;
const ORDER: readonly State[] = ['unsupported', 'retryable', 'waiting-presentation', 'usable'];

describe('U01 a multi-input panel takes its worst input (§7.12 last paragraph)', () => {
  it('U01: transitions take the worst of their inputs in the order unsupported, retryable, waiting-presentation, usable (property)', () => {
    const ranked = fc.record({ state: fc.constantFrom(...ORDER), reason: fc.option(fc.constantFrom('expired', 'too_long', 'grid_mismatch'), { nil: null }) });
    fc.assert(fc.property(fc.array(ranked, { minLength: 1, maxLength: 4 }), (inputs) => {
      const result = worst(inputs);
      expect(result.state).toBe(ORDER[Math.min(...inputs.map((input) => ORDER.indexOf(input.state)))]);
      expect(inputs).toContainEqual(result);
    }), { seed: 130670, numRuns: 100 });
  });
});
