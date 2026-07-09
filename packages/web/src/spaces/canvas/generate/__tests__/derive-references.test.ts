// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';

/**
 * Builds a render-ready {@link CanvasNodeView} fixture for reference tests.
 * @param id - Node id.
 * @param data - The node view payload (must carry `kind`).
 * @returns A CanvasNodeView positioned at the origin.
 */
function node(id: string, data: NodeView): CanvasNodeView {
  return { id, type: data.kind, position: { x: 0, y: 0 }, data };
}

/**
 * Builds a plain edge fixture.
 * @param id - Edge id.
 * @param source - Source node id.
 * @param target - Target node id.
 * @returns A CanvasEdge.
 */
function edge(id: string, source: string, target: string): CanvasEdge {
  return { id, source, target };
}

describe('deriveReferences — reference rail derived from incoming edges (connection = reference)', () => {
  it('derives one reference from a single incoming edge, with the source node live name + thumbnail', () => {
    const nodes: CanvasNodeView[] = [
      node('img1', { kind: 'image', name: 'Hero', status: 'idle', content: 'https://cdn/hero.png' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('img1->me', 'img1', 'me')];

    expect(deriveReferences('me', nodes, edges)).toEqual([
      {
        refId: 'img1->me',
        sourceNodeId: 'img1',
        sourceNodeType: 'image',
        sourceNodeName: 'Hero',
        thumbnail: 'https://cdn/hero.png',
      },
    ]);
  });

  it('ignores edges that do not target the node (outgoing / unrelated)', () => {
    const nodes: CanvasNodeView[] = [
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
      node('other', { kind: 'image', name: 'Other', status: 'idle' }),
    ];
    // me -> other is outgoing from me; other has no incoming to me.
    const edges: CanvasEdge[] = [edge('me->other', 'me', 'other')];

    expect(deriveReferences('me', nodes, edges)).toEqual([]);
  });

  it('derives every incoming edge, preserving edge order', () => {
    const nodes: CanvasNodeView[] = [
      node('a', { kind: 'image', name: 'A', status: 'idle', content: 'a.png' }),
      node('b', { kind: 'video', name: 'B', status: 'idle', coverUrl: 'b-cover.png', content: 'b.mp4' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('a->me', 'a', 'me'), edge('b->me', 'b', 'me')];

    const refs = deriveReferences('me', nodes, edges);
    expect(refs.map((r) => r.sourceNodeId)).toEqual(['a', 'b']);
    // Video thumbnail prefers the cover frame over the raw asset URL.
    expect(refs[1]).toEqual({
      refId: 'b->me',
      sourceNodeId: 'b',
      sourceNodeType: 'video',
      sourceNodeName: 'B',
      thumbnail: 'b-cover.png',
    });
  });

  it('skips a dangling incoming edge whose source node no longer exists', () => {
    const nodes: CanvasNodeView[] = [
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('ghost->me', 'ghost', 'me')];

    expect(deriveReferences('me', nodes, edges)).toEqual([]);
  });

  it('leaves thumbnail undefined for a source node with no visual payload (text)', () => {
    const nodes: CanvasNodeView[] = [
      node('txt', { kind: 'text', name: 'Notes', status: 'idle', content: 'some words' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('txt->me', 'txt', 'me')];

    const refs = deriveReferences('me', nodes, edges);
    expect(refs[0].sourceNodeType).toBe('text');
    expect(refs[0].thumbnail).toBeUndefined();
  });

  it('reflects a live rename of the source node (display fields are live, not frozen)', () => {
    const before: CanvasNodeView[] = [
      node('img1', { kind: 'image', name: 'Old', status: 'idle', content: 'x.png' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const after: CanvasNodeView[] = [
      node('img1', { kind: 'image', name: 'Renamed', status: 'idle', content: 'x.png' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('img1->me', 'img1', 'me')];

    expect(deriveReferences('me', before, edges)[0].sourceNodeName).toBe('Old');
    expect(deriveReferences('me', after, edges)[0].sourceNodeName).toBe('Renamed');
  });
});
