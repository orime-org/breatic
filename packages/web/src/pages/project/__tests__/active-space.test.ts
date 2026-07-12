// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { resolveEffectiveActiveSpace } from '@web/pages/project/active-space';
import type { ProjectSpace } from '@web/data/yjs/project-meta';

const s = (id: string): ProjectSpace => ({ id, name: id, type: 'canvas' });

// The active tab is LOCAL state (batch-2 item 2): opening a project starts
// with no local choice, so the effective active is the FIRST open tab; a
// local choice wins while its tab is still open, and a stale choice (tab
// closed remotely / space vanished) falls back to the first open tab.
describe('resolveEffectiveActiveSpace', () => {
  const openTabs = [s('a'), s('b'), s('c')];

  it('defaults to the first open tab when there is no local choice (project open)', () => {
    expect(resolveEffectiveActiveSpace(openTabs, null)?.id).toBe('a');
  });

  it('honors the local choice while its tab is open', () => {
    expect(resolveEffectiveActiveSpace(openTabs, 'b')?.id).toBe('b');
  });

  it('falls back to the first open tab when the local choice is stale', () => {
    expect(resolveEffectiveActiveSpace(openTabs, 'gone')?.id).toBe('a');
  });

  it('returns undefined when no tabs are open (empty state)', () => {
    expect(resolveEffectiveActiveSpace([], 'b')).toBeUndefined();
  });
});
