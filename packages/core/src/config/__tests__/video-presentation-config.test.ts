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
    expect(config.presentation).toEqual({ container_class: 'MediaContainer', max_source_bytes: getStorageConfig().upload.max_upload_bytes, max_packed_bytes: 1073741824, crf: 18, preset: 'medium', source_ledger: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216,
      iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000,
    } });
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
});
