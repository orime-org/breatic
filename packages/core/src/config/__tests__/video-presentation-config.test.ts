// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { MONOREPO_ROOT } from '../env.js';
import { getMiniToolsConfig, miniToolsConfigSchema } from '../mini-tools.js';
import { getStorageConfig, storageConfigSchema } from '../storage.js';

describe('platform presentation container configuration (inner#1306)', () => {
  it('records the actual basic instance size used by the canonical metadata container', () => {
    const config = getMiniToolsConfig() as unknown as Record<string, unknown>;
    // Design §3.2 item 1 (S6e E1): the target policy version is presentation.policy_version, initial 1.
    expect(config.presentation).toEqual({ container_class: 'MediaContainer', policy_version: 1, max_source_bytes: getStorageConfig().upload.max_upload_bytes, max_packed_bytes: 1073741824, crf: 18, preset: 'medium', source_ledger: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216,
      iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000, max_auto_repairs: 3,
    },
    // Design §4.3 and §8.2 (S6b): short side at most 1080, SDR BT.709 labels. The standard-4 class is
    // encoding.encoder.container_class alone (S6e E1): one key per fact.
    carrier: { max_short_side: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } } });
    expect(getMiniToolsConfig().classes.MediaContainer).toEqual({ instance_type: 'basic', vcpu: 0.25, memory_gib: 1, disk_gb: 4 });
  });

  it('rejects a presentation class whose actual instance size is not configured', () => {
    expect(miniToolsConfigSchema.safeParse({ ...getMiniToolsConfig(), presentation: { container_class: 'UnlistedClass' } }).success).toBe(false);
  });

  // inner#1306 §77 C01: every uploadable video gets a presentation and a ledger,
  // so the presentation source cap is the upload cap, in the shipped YAML and in
  // the loader default alike.
  it('C01 aligns the presentation source cap with the upload cap in the YAML, the getter and the default', () => {
    const read = (name: string): Record<string, unknown> => parse(readFileSync(resolve(MONOREPO_ROOT, `config/${name}`), 'utf8')) as Record<string, unknown>;
    const uploadCap = (read('storage.yaml').upload as Record<string, unknown>).max_upload_bytes;
    expect((read('mini-tools.yaml').presentation as Record<string, unknown>).max_source_bytes).toBe(uploadCap);
    expect(getMiniToolsConfig().presentation.max_source_bytes).toBe(getStorageConfig().upload.max_upload_bytes);
    const { presentation: _omitted, ...legacy } = structuredClone(getMiniToolsConfig());
    expect(miniToolsConfigSchema.parse(legacy).presentation.max_source_bytes).toBe(storageConfigSchema.parse({}).upload.max_upload_bytes);
  });

  // inner#1306 §90 E1 (design §3.2 item 1): the target policy version every
  // admission freezes is a required positive integer in the presentation block.
  it('PV01 reads presentation.policy_version, 1, from the YAML through the getter', () => {
    const presentation = parse(readFileSync(resolve(MONOREPO_ROOT, 'config/mini-tools.yaml'), 'utf8')).presentation as Record<string, unknown>;
    expect(presentation.policy_version).toBe(1);
    expect((getMiniToolsConfig().presentation as unknown as Record<string, unknown>).policy_version).toBe(1);
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '1'],
  ])('PV02 rejects a presentation block whose policy_version is %s', (_name, value) => {
    const base = structuredClone(getMiniToolsConfig()) as unknown as { presentation: Record<string, unknown> };
    expect(miniToolsConfigSchema.safeParse({ ...base, presentation: { ...base.presentation, policy_version: 1 } }).success).toBe(true);
    const presentation: Record<string, unknown> = { ...base.presentation, policy_version: value };
    if (value === undefined) delete presentation.policy_version;
    expect(miniToolsConfigSchema.safeParse({ ...base, presentation }).success).toBe(false);
  });

  // inner#1306 §90 E1: presentation.carrier.container_class duplicated encoding.encoder.container_class; the carrier key goes.
  it('CA01 the carrier block no longer accepts a container_class', () => {
    const base = structuredClone(getMiniToolsConfig()) as unknown as { presentation: { carrier: Record<string, unknown> } & Record<string, unknown> };
    const { container_class: _dropped, ...carrier } = base.presentation.carrier;
    const without = { ...base, presentation: { ...base.presentation, policy_version: 1, carrier } };
    expect(miniToolsConfigSchema.safeParse(without).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse({ ...without, presentation: { ...without.presentation, carrier: { ...carrier, container_class: 'MiniToolContainerStd4' } } }).success).toBe(false);
  });
});
