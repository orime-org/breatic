// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { MONOREPO_ROOT } from '@core/config/env.js';
import { getMiniToolsConfig, miniToolsConfigSchema } from '@core/config/mini-tools.js';

// §2 removes frame-count ceilings, not byte/metadata/container structure budgets.
// Design aed2b550 (S6c) adds max_auto_repairs (initial 3) beside the six byte and structure budgets.
const DEFAULTS = { max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216, iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000, max_auto_repairs: 3 };
const CUSTOM = { max_bytes: 8388608, probe_stdout_bytes: 33554432, metadata_bytes: 2097152, iso_box_count: 80000, matroska_element_count: 500000, matroska_max_blocks: 125000, max_auto_repairs: 5 };
// Design §4.3 and §8.2 (S6b): the carrier's short-side cap and SDR BT.709 labels; its class is encoding.encoder.container_class (S6e E1, §90).
const CARRIER = { max_short_side: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } };
// The budgets must be positive; max_auto_repairs may be zero and is covered by the S6c config cases.
const FIELDS = ['max_bytes', 'probe_stdout_bytes', 'metadata_bytes', 'iso_box_count', 'matroska_element_count', 'matroska_max_blocks'] as const;
const INVALID = [{ label: 'zero', value: 0 }, { label: 'negative', value: -1 }, { label: 'fractional', value: 1.5 }, { label: 'infinity', value: Infinity }, { label: 'NaN', value: NaN }, { label: 'unsafe', value: Number.MAX_SAFE_INTEGER + 1 }];

/** Supplies one policy through the real loader. @throws {Error} When configuration cannot load. */
function withLedger(sourceLedger: unknown): Record<string, unknown> {
  const config = structuredClone(getMiniToolsConfig());
  return { ...config, presentation: { ...config.presentation, source_ledger: sourceLedger } };
}

describe('S4 source ledger byte and structure policy without frame caps', () => {
  it('K01 ships exactly the six retained budgets and the auto-repair cap in YAML and getter', () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')) as { presentation: Record<string, unknown> };
    expect(raw.presentation.source_ledger).toEqual(DEFAULTS);
    expect(getMiniToolsConfig().presentation.source_ledger).toEqual(DEFAULTS);
  });
  it('K02 defaults the whole old presentation without disturbing siblings', () => {
    const { presentation: _omitted, ...legacy } = structuredClone(getMiniToolsConfig());
    expect(miniToolsConfigSchema.parse(legacy)).toEqual({ ...legacy, presentation: { container_class: 'MediaContainer', policy_version: 1, max_source_bytes: 2147483648, max_packed_bytes: 1073741824, crf: 18, preset: 'medium', source_ledger: DEFAULTS, carrier: CARRIER } });
  });
  it('K03 adds policy defaults without replacing configured presentation or plan limits', () => {
    const configured = getMiniToolsConfig();
    // policy_version is required in a configured presentation block (S6e E1, design §3.2 item 1).
    const presentation = { container_class: 'MiniToolContainerStd1', policy_version: 2, max_source_bytes: 4096, max_packed_bytes: 8192, crf: 25, preset: 'fast' };
    const plan_limits = { probeStdoutBytes: 65536, analysisStdoutBytes: 32768, stderrTailBytes: 1024 };
    expect(miniToolsConfigSchema.parse({ ...configured, presentation, plan_limits })).toEqual({ ...configured, presentation: { ...presentation, source_ledger: DEFAULTS, carrier: CARRIER }, plan_limits });
  });
  it('K04 defaults an empty policy, preserves explicit overrides and both safe integer boundaries', () => {
    expect(miniToolsConfigSchema.parse(withLedger({})).presentation.source_ledger).toEqual(DEFAULTS);
    expect(miniToolsConfigSchema.parse(withLedger(CUSTOM)).presentation.source_ledger).toEqual(CUSTOM);
    for (const value of [1, Number.MAX_SAFE_INTEGER]) {
      const policy = Object.fromEntries(FIELDS.map((field) => [field, value]));
      expect(miniToolsConfigSchema.parse(withLedger(policy)).presentation.source_ledger).toEqual({ ...policy, max_auto_repairs: 3 });
    }
  });
  it.each(FIELDS)('K05 overrides %s without replacing the other five defaults', (field) => {
    expect(miniToolsConfigSchema.parse(withLedger({ [field]: CUSTOM[field] })).presentation.source_ledger).toEqual({ ...DEFAULTS, [field]: CUSTOM[field] });
  });
  it.each(FIELDS.flatMap((field) => INVALID.map(({ label, value }) => ({ field, label, value }))))('K06 rejects $label for $field', ({ field, value }) => {
    expect(miniToolsConfigSchema.safeParse(withLedger(CUSTOM)).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse(withLedger({ ...CUSTOM, [field]: value })).success).toBe(false);
  });
  it.each(['max_physical_frames', 'max_occurrences'])('K07 rejects retired frame cap %s instead of exposing it to consumers', (field) => {
    expect(miniToolsConfigSchema.parse(withLedger(CUSTOM)).presentation.source_ledger).toEqual(CUSTOM);
    expect(miniToolsConfigSchema.safeParse(withLedger({ ...CUSTOM, [field]: 100000 })).success).toBe(false);
  });
});
