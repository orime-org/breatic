// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The ledger failure classification (inner#1306 test plan §76, F cases).
 *
 * The L and R groups of §76 (the stored v2 ledger and its receipt schema) were
 * removed with those exports in S6e E4 (test plan §90, first deletion batch):
 * nothing outside tests read them after the S6c/E2 ledger rewrite.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyVideoSourceLedgerFailure } from '../video-source-ledger.js';

/**
 * The classification under test.
 * @param _name - Kept so the cases read as before.
 * @returns The classifier.
 * @throws {never} Never.
 */
function required(_name: 'classifyVideoSourceLedgerFailure'): typeof classifyVideoSourceLedgerFailure {
  return classifyVideoSourceLedgerFailure;
}

// Design §10.6 "失败分类": a code is transient when running the producer again on the
// same source bytes under the same frozen policy can give a different result, content
// when the bytes and the frozen policy decide it. Limits frozen at admission
// (`resource_limit`, `source_ledger_over_cap`) are content; a real exhaustion of
// container memory, disk or processes is the transient `resource_exhausted`.
const TRANSIENT = [
  'expired', 'source_ledger_missing', 'source_ledger_invalid', 'presentation_failed', 'presentation_report_failed', 'cleanup_failed',
  'admission_invalid', 'source_missing', 'invalid_limits', 'resource_exhausted',
  // The producer's catch-all for unclassified exceptions.
  'source_ledger_failed',
] as const;
const CONTENT = [
  'source_ledger_format_unknown', 'source_ledger_selection_unknown', 'unsupported_rate', 'invalid_edit', 'invalid_clock', 'invalid_ledger',
  'classification_unknown', 'clock_unknown', 'metadata_unknown', 'audio_clock_unknown', 'probe_invalid', 'source_over_cap', 'no_presented_frames',
  'resource_limit', 'source_ledger_over_cap',
] as const;
// Presentation candidate codes classified by the same function (§10.6); they are never written into ledger state (§7.4).
const CANDIDATE_CONTENT = ['too_long', 'packed_over_cap', 'packed_clock_mismatch'] as const;

describe('F ledger and candidate failure classification', () => {
  it.each(TRANSIENT)('F01 %s is transient', (code) => {
    expect(required('classifyVideoSourceLedgerFailure')(code)).toBe('transient');
  });

  it.each(CONTENT)('F02 %s is content', (code) => {
    expect(required('classifyVideoSourceLedgerFailure')(code)).toBe('content');
  });

  it.each(CANDIDATE_CONTENT)('F03 candidate code %s is content', (code) => {
    expect(required('classifyVideoSourceLedgerFailure')(code)).toBe('content');
  });

  it.each(['metadata_mismatch', 'attempt_conflict', 'not_a_known_code'])('F03 unlisted code %s is transient', (code) => {
    expect(required('classifyVideoSourceLedgerFailure')(code)).toBe('transient');
  });

  it('F04 a code is content exactly when it is a ledger or candidate content code (property)', () => {
    const classify = required('classifyVideoSourceLedgerFailure');
    const content = new Set<string>([...CONTENT, ...CANDIDATE_CONTENT]);
    fc.assert(fc.property(fc.oneof(fc.stringMatching(/^[a-z][a-z0-9_]{0,40}$/), fc.constantFrom(...CONTENT, ...CANDIDATE_CONTENT, ...TRANSIENT)), (code) => {
      expect(classify(code)).toBe(content.has(code) ? 'content' : 'transient');
    }), { seed: 1306, numRuns: 300 });
  });
});
