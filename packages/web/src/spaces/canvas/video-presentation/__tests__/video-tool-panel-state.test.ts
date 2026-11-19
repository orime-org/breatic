// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyVideoSourceLedgerFailure, type VideoPresentationResponse } from '@breatic/shared';
import * as owner from '../use-canvas-video-bindings';
import { PRESENTED, presentedBinding, presentedBundle, presentedPreparation, presentedResponse, readyLedger } from '@web/test-utils/video-presentation';

// §95 (frames-split design §7.12, §10.4 fact C): one pure derivation of the five states from the read, taking the first of
// steps 1–5 that holds. The response carries the selected bundle (P), the target policy's preparation (candidate A and its
// failure code) and P's ledger (L); a compact table is usable only bound to P's toolInputId. `resourceVersionId` is the
// version the surface currently shows (step 3; its input name is question D9-1).
type State = 'waiting-presentation' | 'waiting-table' | 'usable' | 'retryable' | 'unsupported';
interface Input {
  sourceURL: string;
  presentationStatus: 'loading' | 'ready' | 'failed';
  response: VideoPresentationResponse | undefined;
  resourceVersionId: string | null;
  table: owner.CanonicalVideoFrameTable | null;
  tableStatus: 'pending' | 'success' | 'error';
  retrying: boolean;
}
const api = owner as unknown as { deriveVideoToolPanelState: (input: Input) => State };
const url = 'https://assets.example.test/video/source.webm';
const binding = presentedBinding(url, { width: 96, height: 64, duration: 3, mimeType: 'video/webm' });
const bundle = presentedBundle(url);
const table = { schemaVersion: 1 as const, timescale: 25, runs: [{ start: 0, count: 75, step: 1, duration: 1 }] };
const response = presentedResponse(binding, { presentation: bundle, ledger: readyLedger(bundle) });
const usable: Input = { sourceURL: url, presentationStatus: 'ready', response, resourceVersionId: PRESENTED.versionId,
  table: { sourceKey: JSON.stringify([url, PRESENTED.toolInputId]), table }, tableStatus: 'success', retrying: false };
const derive = (input: Input): State => api.deriveVideoToolPanelState(input);
const classOf = (code: string): State => classifyVideoSourceLedgerFailure(code) === 'transient' ? 'retryable' : 'unsupported';

/**
 * A read with nothing selected and the given preparation.
 * @param failure - The candidate's failure code, null while it runs.
 * @returns The input.
 */
function unselected(failure: string | null): Input {
  return { ...usable, response: presentedResponse(binding, { preparation: presentedPreparation(failure) }), resourceVersionId: null, table: null, tableStatus: 'pending' };
}

/**
 * A read with P selected and its ledger in the given state.
 * @param ledger - P's ledger.
 * @returns The input.
 */
function withLedger(ledger: VideoPresentationResponse['ledger']): Input {
  return { ...usable, table: null, tableStatus: 'pending', response: presentedResponse(binding, { presentation: bundle, ledger }) };
}

describe('the single panel derivation (§95; design §7.12 steps 1–5, §10.4)', () => {
  it('P01 usable requires P, its resource, a ready L and a compact table bound to P\'s toolInputId (step 5)', () => {
    expect(derive(usable)).toBe('usable');
    expect(derive({ ...usable, table: null, tableStatus: 'pending' })).toBe('waiting-table');
  });

  it.each(['loading', 'failed'] as const)('P02 a presentation read %s is step 1: waiting-presentation', (presentationStatus) => {
    expect(derive(usable)).toBe('usable');
    expect(derive({ ...usable, presentationStatus, response: undefined })).toBe('waiting-presentation');
  });

  it('P03 step 2: nothing selected and the candidate not failed (none yet, or in progress) is waiting-presentation', () => {
    expect(derive({ ...unselected(null), response: presentedResponse(binding) })).toBe('waiting-presentation');
    expect(derive(unselected(null))).toBe('waiting-presentation');
  });

  // Step 2: the candidate's failure is classified by §10.6; presentation_invalid (a re-presented version invalid again) and
  // reuse_source_invalid (§93 D6-4) are transient, so retryable; too_long and the probe's content codes are unsupported.
  it.each(['presentation_invalid', 'reuse_source_invalid', 'expired', 'container_failed', 'too_long', 'classification_unknown', 'source_ledger_plan_mismatch'])(
    'P04 step 2: nothing selected and the candidate failed %s follows the shared classifier', (code) => {
      expect(derive(unselected(null))).toBe('waiting-presentation');
      expect(derive(unselected(code))).toBe(classOf(code));
    });

  it('P05 step 2 names the two invalidation codes retryable, not unsupported', () => {
    expect([derive(unselected('presentation_invalid')), derive(unselected('reuse_source_invalid')), derive(unselected('too_long'))]).toEqual(['retryable', 'retryable', 'unsupported']);
  });

  it('P06 step 3: P selected but the surface shows no resource or another version is waiting-presentation', () => {
    expect(derive(usable)).toBe('usable');
    expect(derive({ ...usable, resourceVersionId: null })).toBe('waiting-presentation');
    expect(derive({ ...usable, resourceVersionId: 'b'.repeat(64) })).toBe('waiting-presentation');
  });

  it.each([
    ['absent', null, 'waiting-table'],
    ['pending', { state: 'pending', receipt: null, failure: null }, 'waiting-table'],
    ['failed transient (expired)', { state: 'failed', receipt: null, failure: 'expired' }, 'retryable'],
    ['failed transient (source_ledger_invalid)', { state: 'failed', receipt: null, failure: 'source_ledger_invalid' }, 'retryable'],
    ['failed content (invalid_edit)', { state: 'failed', receipt: null, failure: 'invalid_edit' }, 'unsupported'],
  ] as const)('P07 step 4: L %s', (_name, ledger, state) => {
    expect(derive(usable)).toBe('usable');
    expect(derive(withLedger(ledger as VideoPresentationResponse['ledger']))).toBe(state);
  });

  it('P08 step 4: a ready L whose compact read fails is retryable, a read in progress or a retry press waits for the table', () => {
    expect(derive({ ...usable, table: null, tableStatus: 'error' })).toBe('retryable');
    expect(derive({ ...usable, table: null, tableStatus: 'pending' })).toBe('waiting-table');
    expect(derive({ ...withLedger({ state: 'failed', receipt: null, failure: 'expired' }), retrying: true })).toBe('waiting-table');
    expect(derive({ ...usable, retrying: true })).toBe('waiting-table');
  });

  it('P09 step 4: a target preparation in progress or failed beside a usable P leaves the panel usable', () => {
    for (const preparation of [presentedPreparation(null, 'encode'), presentedPreparation('too_long'), presentedPreparation('presentation_invalid')]) {
      expect(derive({ ...usable, response: { ...response, preparation } })).toBe('usable');
    }
  });

  it('P10 step 5: a compact table bound to another toolInputId, or to the source fingerprint, is never usable', () => {
    expect(derive(usable)).toBe('usable');
    expect(derive({ ...usable, table: { sourceKey: JSON.stringify([url, 'b'.repeat(64)]), table } })).toBe('waiting-table');
    expect(derive({ ...usable, table: { sourceKey: JSON.stringify([url, PRESENTED.fingerprint]), table } })).toBe('waiting-table');
  });

  it('P11 a source switch resets every old display state (property)', () => {
    expect(derive(usable)).toBe('usable');
    fc.assert(fc.property(fc.constantFrom(usable, unselected('presentation_invalid'), withLedger({ state: 'failed', receipt: null, failure: 'invalid_edit' }), { ...usable, table: null }), fc.webUrl(), (input, next) => {
      fc.pre(next !== url);
      expect(derive({ ...input, sourceURL: next })).toBe('waiting-presentation');
    }), { seed: 130604, numRuns: 50 });
  });

  it('P12 ready → L invalid → pending → ready follows only new read facts', () => {
    expect([usable, withLedger({ state: 'failed', receipt: null, failure: 'source_ledger_invalid' }), withLedger({ state: 'pending', receipt: null, failure: null }), usable].map(derive))
      .toEqual(['usable', 'retryable', 'waiting-table', 'usable']);
  });
});

// §95 D9-2 (design §7.12 末段): a multi-input tool (transitions) derives each input on its own and shows the worst, in the
// order unsupported, retryable, waiting-presentation, waiting-table, usable, with that input's reason code. The reason is
// a code, never copy (D9-3: the copy waits for the demo).
interface Ranked { state: State; reason: string | null }
const worst = (owner as unknown as { worstVideoToolPanelState: (inputs: readonly Ranked[]) => Ranked }).worstVideoToolPanelState;
const ORDER: readonly State[] = ['unsupported', 'retryable', 'waiting-presentation', 'waiting-table', 'usable'];

describe('the worst input of a multi-input panel (§95 D9-2; design §7.12)', () => {
  it('W01 takes the worst state and that input\'s reason code', () => {
    expect(worst([{ state: 'usable', reason: null }, { state: 'retryable', reason: 'expired' }, { state: 'waiting-table', reason: null }])).toEqual({ state: 'retryable', reason: 'expired' });
    expect(worst([{ state: 'waiting-table', reason: null }, { state: 'unsupported', reason: 'too_long' }, { state: 'retryable', reason: 'presentation_invalid' }])).toEqual({ state: 'unsupported', reason: 'too_long' });
    expect(worst([{ state: 'waiting-table', reason: null }, { state: 'waiting-presentation', reason: null }])).toEqual({ state: 'waiting-presentation', reason: null });
  });

  it('W02 one input is its own panel state', () => {
    for (const state of ORDER) expect(worst([{ state, reason: state === 'usable' ? null : 'code' }])).toEqual({ state, reason: state === 'usable' ? null : 'code' });
  });

  it('W03 the panel is usable only when every input is usable, and its state is always the worst by the order (property)', () => {
    const ranked = fc.record({ state: fc.constantFrom(...ORDER), reason: fc.option(fc.constantFrom('expired', 'too_long', 'presentation_invalid', 'invalid_edit'), { nil: null }) });
    fc.assert(fc.property(fc.array(ranked, { minLength: 1, maxLength: 6 }), (inputs) => {
      const result = worst(inputs);
      const rank = Math.min(...inputs.map((input) => ORDER.indexOf(input.state)));
      expect(result.state).toBe(ORDER[rank]);
      expect(inputs).toContainEqual(result);
    }), { seed: 130695, numRuns: 100 });
  });
});
