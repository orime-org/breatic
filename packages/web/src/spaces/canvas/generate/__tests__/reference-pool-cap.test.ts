// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reference-pool cap math (#1782): incoming reference edges + focus crops
 * combined, gated per target node against the config knob.
 */

import { describe, it, expect } from 'vitest';

import {
  referencePoolCount,
  isReferencePoolFull,
} from '@web/spaces/canvas/generate/reference-pool-cap';

const edge = (source: string, target: string) => ({ source, target });
const focus = (id: string) => ({
  id,
  url: `https://cdn/${id}.png`,
  name: 'src',
  width: 10,
  height: 10,
});

const srcNodes = [{ id: 'a' }, { id: 'b' }, { id: 'gen' }, { id: 'other' }];

describe('referencePoolCount', () => {
  it('counts incoming edges of the target only', () => {
    const edges = [edge('a', 'gen'), edge('b', 'gen'), edge('gen', 'other')];
    expect(referencePoolCount(edges, srcNodes, 'gen')).toBe(2);
  });

  it('excludes dangling edges whose source is gone — the rail renders none (adversarial R2)', () => {
    // Concurrent connect + source-delete merges into an edge with no source
    // node: deriveReferences skips it (no row, no ✕), so the count must too
    // or the phantom occupies an invisible, UI-unremovable cap slot.
    const edges = [edge('a', 'gen'), edge('ghost-src', 'gen')];
    expect(referencePoolCount(edges, srcNodes, 'gen')).toBe(1);
  });

  it('adds the target node focus crops to the count', () => {
    const nodes = [
      { id: 'gen', data: { focusImages: [focus('f1'), focus('f2')] } },
      { id: 'other', data: { focusImages: [focus('f3')] } },
    ];
    expect(
      referencePoolCount([edge('a', 'gen')], [...nodes, { id: 'a' }], 'gen'),
    ).toBe(3);
  });

  it('is 0 for a missing node with no edges', () => {
    expect(referencePoolCount([], [], 'ghost')).toBe(0);
  });

  it('ignores a malformed (non-array) focusImages from untrusted Yjs data', () => {
    const nodes = [
      { id: 'gen', data: { focusImages: 'not-an-array' as unknown as [] } },
    ];
    expect(referencePoolCount([], nodes, 'gen')).toBe(0);
  });

  it('counts only VALID entries — malformed remote entries never occupy cap slots', () => {
    // Adversarial 2026-07-16: the count must agree with what the panel
    // renders (one shared sanitizer); raw-length counting made invisible,
    // UI-unremovable entries permanently eat the pool cap.
    const nodes = [
      {
        id: 'gen',
        data: {
          focusImages: [
            focus('ok'),
            null,
            { id: '', url: 'https://cdn/x.png', name: 'x', width: 1, height: 1 },
            { id: 'no-dims', url: 'https://cdn/y.png', name: 'y' },
          ] as unknown as [],
        },
      },
    ];
    expect(referencePoolCount([], nodes, 'gen')).toBe(1);
  });
});

describe('isReferencePoolFull', () => {
  it('is false below the cap and true at the cap', () => {
    const edges = [edge('a', 'gen'), edge('b', 'gen')];
    expect(isReferencePoolFull(edges, srcNodes, 'gen', 3)).toBe(false);
    expect(isReferencePoolFull(edges, srcNodes, 'gen', 2)).toBe(true);
  });

  it('counts focus crops toward the cap', () => {
    const nodes = [
      { id: 'a' },
      { id: 'gen', data: { focusImages: [focus('f1')] } },
    ];
    expect(isReferencePoolFull([edge('a', 'gen')], nodes, 'gen', 2)).toBe(true);
    expect(isReferencePoolFull([edge('a', 'gen')], nodes, 'gen', 3)).toBe(false);
  });
});
