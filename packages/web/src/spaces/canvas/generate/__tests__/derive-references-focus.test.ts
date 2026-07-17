// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Focus crops as pool entries (#1782): the `focus:` id namespace and the
 * FocusImage → rail-item mapping that lets the whole mention / rail /
 * cascade plumbing treat crops as ordinary pool rows.
 */

import { describe, it, expect } from 'vitest';

import {
  FOCUS_REF_PREFIX,
  focusRefId,
  focusIdOfRefId,
  focusToRailItem,
} from '@web/spaces/canvas/generate/derive-references';

const CROP = {
  id: 'f1',
  url: 'https://cdn/crop.png',
  name: 'Image Node 26',
  width: 640,
  height: 360,
};

describe('focus pool entries', () => {
  it('maps a FocusImage to a rail item in the focus: namespace', () => {
    const item = focusToRailItem(CROP);
    expect(item).toEqual({
      refId: `${FOCUS_REF_PREFIX}f1`,
      sourceNodeId: `${FOCUS_REF_PREFIX}f1`,
      sourceNodeType: 'image',
      sourceNodeName: 'Image Node 26',
      thumbnail: 'https://cdn/crop.png',
      focus: true,
    });
  });

  it('focusRefId / focusIdOfRefId round-trip; node ids resolve to null', () => {
    expect(focusRefId('f1')).toBe('focus:f1');
    expect(focusIdOfRefId('focus:f1')).toBe('f1');
    expect(focusIdOfRefId('edge-or-node-uuid')).toBeNull();
  });
});

describe('focus: namespace squatting (round-9)', () => {
  it('deriveReferences skips a forged canvas node whose id squats in the focus: namespace', async () => {
    const { deriveReferences } = await import(
      '@web/spaces/canvas/generate/derive-references'
    );
    const nodes = [
      {
        id: 'focus:f1',
        data: { kind: 'image', status: 'idle', content: 'https://evil/x.png' },
      },
    ] as never[];
    const edges = [{ id: 'focus:f1->gen', source: 'focus:f1', target: 'gen' }];
    expect(deriveReferences('gen', nodes, edges)).toEqual([]);
  });

  it('referencePoolCount does not let the squatter edge occupy a cap slot', async () => {
    const { referencePoolCount } = await import(
      '@web/spaces/canvas/generate/reference-pool-cap'
    );
    const nodes = [{ id: 'focus:f1' }, { id: 'gen' }];
    const edges = [{ id: 'e', source: 'focus:f1', target: 'gen' }];
    expect(referencePoolCount(edges, nodes, 'gen')).toBe(0);
  });

  it('deriveReferences skips a forged EDGE whose id squats in the focus: namespace (round-12)', async () => {
    const { deriveReferences } = await import(
      '@web/spaces/canvas/generate/derive-references'
    );
    // The row's refId = the edge id: a forged edge id colliding with a
    // crop's `focus:` pool id would render two rail rows with the same
    // React key and misroute the ✕ removal.
    const nodes = [
      {
        id: 'src-1',
        data: { kind: 'image', status: 'idle', content: 'https://cdn/a.png' },
      },
    ] as never[];
    const edges = [{ id: 'focus:f1', source: 'src-1', target: 'gen' }];
    expect(deriveReferences('gen', nodes, edges)).toEqual([]);
  });

  it('referencePoolCount does not let a forged focus:-id edge occupy a cap slot (round-12)', async () => {
    const { referencePoolCount } = await import(
      '@web/spaces/canvas/generate/reference-pool-cap'
    );
    // The rail refuses to render it (test above) — so it must not occupy a
    // cap slot either (the round-2 invariant: uncountable = unrenderable).
    const nodes = [{ id: 'src-1' }, { id: 'gen' }];
    const edges = [{ id: 'focus:f1', source: 'src-1', target: 'gen' }];
    expect(referencePoolCount(edges, nodes, 'gen')).toBe(0);
  });
});

