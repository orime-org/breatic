// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyVideoSourceLedgerFailure, type VideoPresentationResponse } from '@breatic/shared';
import * as owner from '../use-canvas-video-bindings';

// §10.4 fact C: this is a pure derivation, not another ledger state machine.
type State = 'waiting-presentation' | 'waiting-table' | 'usable' | 'retryable' | 'unsupported';
interface Input {
  sourceURL: string;
  presentationStatus: 'loading' | 'ready' | 'failed';
  response: VideoPresentationResponse | undefined;
  table: owner.CanonicalVideoFrameTable | null;
  tableStatus: 'pending' | 'success' | 'error';
  retrying: boolean;
}
const api = owner as unknown as { deriveVideoToolPanelState: (input: Input) => State };
const url = 'https://assets.example.test/source.webm';
const hash = 'a'.repeat(64);
const attempt = { jobId: 'ledger-job', deadlineAt: 1 };
const table = { schemaVersion: 1 as const, timescale: 1000, runs: [{ start: 2000, count: 3, step: 40, duration: 30 }] };
const receipt = { schemaVersion: 2 as const, producerVersion: 2 as const, sourceFingerprint: hash, attempt, url: `${url}.full`, etag: 'opaque', size: 1000, sha256: 'b'.repeat(64), contentType: 'application/json' as const, table: { url: `${url}.table`, size: 100, sha256: 'c'.repeat(64), frameCount: 3 } };
const response: VideoPresentationResponse = { sourceBinding: { assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', canonicalURL: url, contentHash: hash, kind: 'video', mediaInfo: { width: 96, height: 64, duration: 3, mimeType: 'video/webm' } }, presentation: { schemaVersion: 1, sourceFingerprint: hash, original: { width: 96, height: 64, duration: 3 }, state: 'native' }, preparation: null, pollAfterMs: null, sourceLedger: { state: 'ready', receipt } };
const usable: Input = { sourceURL: url, presentationStatus: 'ready', response, table: { sourceKey: JSON.stringify([url, hash]), table }, tableStatus: 'success', retrying: false };

/** Carries an authoritative new ledger fact, never local ledger state. @throws {never} Never. */
function failed(code: string): Input {
  return { ...usable, table: null, tableStatus: 'pending', response: { ...response, sourceLedger: { state: 'failed', schemaVersion: 2, producerVersion: 2, sourceFingerprint: hash, attempt, errorCode: code } } };
}

describe('S4 single pure panel derivation (§10.4)', () => {
  it('P01 usable requires ready current source, presentation and validated compact table', () => {
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
    expect(api.deriveVideoToolPanelState({ ...usable, table: null, tableStatus: 'pending' })).toBe('waiting-table');
  });
  it.each(['loading', 'failed'] as const)('P02 presentation %s cannot expose a usable table', (presentationStatus) => {
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
    expect(api.deriveVideoToolPanelState({ ...usable, presentationStatus })).toBe('waiting-presentation');
  });
  it.each([undefined, null, { state: 'pending', schemaVersion: 2, producerVersion: 2, sourceFingerprint: hash, attempt }])('P03 absent/pending authoritative ledger waits even with stale read data', (sourceLedger) => {
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
    expect(api.deriveVideoToolPanelState({ ...usable, response: { ...response, sourceLedger } as VideoPresentationResponse })).toBe('waiting-table');
  });
  it.each(['expired', 'source_ledger_invalid', 'source_ledger_missing', 'resource_limit', 'unknown_future_code', 'unsupported_rate', 'no_presented_frames', 'invalid_edit'])('P04 maps %s using the shared classifier', (code) => {
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
    expect(api.deriveVideoToolPanelState(failed(code))).toBe(classifyVideoSourceLedgerFailure(code) === 'transient' ? 'retryable' : 'unsupported');
  });
  it('P05 read validation failure is retryable despite a ready receipt', () => {
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
    expect(api.deriveVideoToolPanelState({ ...usable, table: null, tableStatus: 'error' })).toBe('retryable');
  });
  it('P06 a retry waits for refreshed facts, not the stale successful table', () => {
    expect(api.deriveVideoToolPanelState(failed('expired'))).toBe('retryable');
    expect(api.deriveVideoToolPanelState({ ...failed('expired'), retrying: true })).toBe('waiting-table');
    expect(api.deriveVideoToolPanelState({ ...usable, retrying: true })).toBe('waiting-table');
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
  });
  it('P07 ready→physical invalidation→pending→ready follows only new query facts', () => {
    expect([usable, failed('source_ledger_invalid'), { ...usable, table: null, tableStatus: 'pending' as const }, usable].map(api.deriveVideoToolPanelState)).toEqual(['usable', 'retryable', 'waiting-table', 'usable']);
  });
  it('P08 a source switch resets every old display state (property)', () => {
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
    fc.assert(fc.property(fc.constantFrom(usable, failed('expired'), failed('invalid_edit'), { ...usable, table: null }), fc.webUrl(), (input, next) => {
      fc.pre(next !== url);
      expect(api.deriveVideoToolPanelState({ ...input, sourceURL: next })).toBe('waiting-presentation');
    }), { seed: 130604, numRuns: 50 });
  });
  it('P09 a table bound to a different fingerprint is never usable', () => {
    expect(api.deriveVideoToolPanelState(usable)).toBe('usable');
    expect(api.deriveVideoToolPanelState({ ...usable, table: { sourceKey: JSON.stringify([url, 'b'.repeat(64)]), table } })).toBe('waiting-table');
  });
});
