// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  MINI_TOOLS,
  getMiniTool,
  miniToolsForModality,
} from '@web/pages/project/mini-tool-system/catalog';

describe('mini-tool catalog', () => {
  it('has exactly 47 tools (the unified catalog size)', () => {
    expect(MINI_TOOLS.length).toBe(47);
  });

  it('every tool has a unique id', () => {
    const ids = new Set(MINI_TOOLS.map((t) => t.id));
    expect(ids.size).toBe(MINI_TOOLS.length);
  });

  it('every tool declares source + output modality + runtime', () => {
    MINI_TOOLS.forEach((t) => {
      expect(['text', 'image', 'audio', 'video']).toContain(t.source);
      expect(['text', 'image', 'audio', 'video']).toContain(t.output);
      expect(['text-sse', 'worker']).toContain(t.runtime);
    });
  });

  it('all 10 text tools run via text-sse', () => {
    const textTextTools = MINI_TOOLS.filter(
      (t) => t.source === 'text' && t.output === 'text',
    );
    expect(textTextTools.length).toBe(10);
    textTextTools.forEach((t) => {
      expect(t.runtime).toBe('text-sse');
    });
  });

  it('miniToolsForModality(image) returns only image-source tools', () => {
    const out = miniToolsForModality('image');
    expect(out.length).toBeGreaterThan(0);
    out.forEach((t) => {
      expect(t.source).toBe('image');
    });
  });

  it('getMiniTool resolves a known id and returns undefined for unknown', () => {
    expect(getMiniTool('polish')?.label).toBe('Polish');
    expect(getMiniTool('nope')).toBeUndefined();
  });
});
