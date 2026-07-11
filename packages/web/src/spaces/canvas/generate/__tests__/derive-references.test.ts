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
 * @param createdAt - Optional connection timestamp (epoch ms).
 * @returns A CanvasEdge.
 */
function edge(
  id: string,
  source: string,
  target: string,
  createdAt?: number,
): CanvasEdge {
  return createdAt === undefined
    ? { id, source, target }
    : { id, source, target, createdAt };
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

  // Text-chip serialization + hover (spec §9.1): a text reference carries its
  // source node's live text body so the prompt serializer can substitute the
  // chip with the content and the rail hover can preview it.
  it('carries the text body for a text source (textContent), nothing for other kinds', () => {
    const nodes: CanvasNodeView[] = [
      node('txt', { kind: 'text', name: 'Notes', status: 'idle', content: 'some words' }),
      node('img1', { kind: 'image', name: 'Pic', status: 'idle', content: 'x.png' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [
      edge('txt->me', 'txt', 'me', 1000),
      edge('img1->me', 'img1', 'me', 2000),
    ];

    const refs = deriveReferences('me', nodes, edges);
    expect(refs[0].textContent).toBe('some words');
    expect(refs[1].textContent).toBeUndefined();
  });

  // Reference order = connection time (batch-2 item 7, user 2026-07-11): the
  // rail and the @ picker must list references in the order they were drawn,
  // newest LAST. Y.Map iteration order is struct-store order (clientID+clock),
  // which diverges from insertion order after reload / cross-client sync — so
  // ordering must come from the createdAt stamp, never from array position.
  describe('ordering by createdAt (connection time)', () => {
    const nodes: CanvasNodeView[] = [
      node('a', { kind: 'image', name: 'A', status: 'idle', content: 'a.png' }),
      node('b', { kind: 'image', name: 'B', status: 'idle', content: 'b.png' }),
      node('c', { kind: 'image', name: 'C', status: 'idle', content: 'c.png' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];

    it('sorts rows by createdAt ascending regardless of the edges-array order (Y.Map order independence)', () => {
      // Scrambled array order (as a reload can produce): c(3000), a(1000), b(2000).
      const edges: CanvasEdge[] = [
        edge('c->me', 'c', 'me', 3000),
        edge('a->me', 'a', 'me', 1000),
        edge('b->me', 'b', 'me', 2000),
      ];
      expect(deriveReferences('me', nodes, edges).map((r) => r.sourceNodeId)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('treats a missing createdAt as oldest (legacy edges precede stamped ones)', () => {
      const edges: CanvasEdge[] = [
        edge('c->me', 'c', 'me', 3000),
        edge('a->me', 'a', 'me'),
        edge('b->me', 'b', 'me'),
      ];
      expect(deriveReferences('me', nodes, edges).map((r) => r.sourceNodeId)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    // Adversarial (round-1): "stable among themselves" was an illusion — the
    // input order IS Y.Map struct-store order, which differs across clients
    // mid-session and flips on reload. Ties (all legacy edges; same-ms stamps)
    // need a DETERMINISTIC tiebreak that every client derives identically:
    // the edge id.
    it('breaks createdAt ties by edge id — same order regardless of input order', () => {
      const scrambled: CanvasEdge[] = [
        edge('b->me', 'b', 'me'),
        edge('a->me', 'a', 'me'),
      ];
      const reversed: CanvasEdge[] = [
        edge('a->me', 'a', 'me'),
        edge('b->me', 'b', 'me'),
      ];
      const fromScrambled = deriveReferences('me', nodes, scrambled).map((r) => r.refId);
      const fromReversed = deriveReferences('me', nodes, reversed).map((r) => r.refId);
      expect(fromScrambled).toEqual(fromReversed);
      expect(fromScrambled).toEqual(['a->me', 'b->me']);
    });

    it('breaks a same-millisecond stamp tie by edge id too', () => {
      const edges: CanvasEdge[] = [
        edge('c->me', 'c', 'me', 500),
        edge('b->me', 'b', 'me', 500),
      ];
      expect(deriveReferences('me', nodes, edges).map((r) => r.refId)).toEqual([
        'b->me',
        'c->me',
      ]);
    });

    it('does not mutate the caller-owned edges array while sorting', () => {
      const edges: CanvasEdge[] = [
        edge('c->me', 'c', 'me', 3000),
        edge('a->me', 'a', 'me', 1000),
      ];
      deriveReferences('me', nodes, edges);
      expect(edges.map((e) => e.id)).toEqual(['c->me', 'a->me']);
    });
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
