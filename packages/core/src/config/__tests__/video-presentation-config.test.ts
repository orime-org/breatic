// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { getMiniToolsConfig, miniToolsConfigSchema } from '../mini-tools.js';

describe('platform presentation container configuration (inner#1306)', () => {
  it('records the actual basic instance size used by the canonical metadata container', () => {
    const config = getMiniToolsConfig() as unknown as Record<string, unknown>;
    expect(config.presentation).toEqual({ container_class: 'MediaContainer', max_source_bytes: 1073741824, max_packed_bytes: 1073741824, crf: 18, preset: 'medium' });
    expect(getMiniToolsConfig().classes.MediaContainer).toEqual({ instance_type: 'basic', vcpu: 0.25, memory_gib: 1, disk_gb: 4 });
  });

  it('rejects a presentation class whose actual instance size is not configured', () => {
    expect(miniToolsConfigSchema.safeParse({ ...getMiniToolsConfig(), presentation: { container_class: 'UnlistedClass' } }).success).toBe(false);
  });
});
