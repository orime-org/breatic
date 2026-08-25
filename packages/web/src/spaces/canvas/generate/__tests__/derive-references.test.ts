// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeView } from '@web/spaces/canvas/types/node-view';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';

/** No body text for this case — the parameter is required so omitting it cannot be an accident. */
const NO_TEXT: ReadonlyMap<string, string> = new Map();

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

    expect(deriveReferences('me', nodes, edges, NO_TEXT)).toEqual([
      {
        refId: 'img1->me',
        sourceNodeId: 'img1',
        sourceNodeType: 'image',
        sourceNodeName: 'Hero',
        thumbnail: 'https://cdn/hero.png',
        mediaUrl: 'https://cdn/hero.png',
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

    expect(deriveReferences('me', nodes, edges, NO_TEXT)).toEqual([]);
  });

  it('derives every incoming edge, preserving edge order', () => {
    const nodes: CanvasNodeView[] = [
      node('a', { kind: 'image', name: 'A', status: 'idle', content: 'a.png' }),
      node('b', { kind: 'video', name: 'B', status: 'idle', coverUrl: 'b-cover.png', content: 'b.mp4' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('a->me', 'a', 'me'), edge('b->me', 'b', 'me')];

    const refs = deriveReferences('me', nodes, edges, NO_TEXT);
    expect(refs.map((r) => r.sourceNodeId)).toEqual(['a', 'b']);
    // Video thumbnail is the cover frame (never the raw asset URL — #1821);
    // the raw asset URL rides along as `mediaUrl`, which is what the hover
    // card plays (#1945). Two fields because they answer two questions.
    expect(refs[1]).toEqual({
      refId: 'b->me',
      sourceNodeId: 'b',
      sourceNodeType: 'video',
      sourceNodeName: 'B',
      thumbnail: 'b-cover.png',
      mediaUrl: 'b.mp4',
    });
  });

  it('leaves a coverless video thumbnail undefined — never the raw video URL (#1821)', () => {
    // A video with no cover (uploaded before #1816, or a generation whose
    // ffmpeg cover step failed) must NOT surface its video URL as a thumbnail:
    // a video URL fed to an <img> is a broken image. It degrades to undefined
    // so the rail / chip fall back to a modality icon.
    const nodes: CanvasNodeView[] = [
      node('v', { kind: 'video', name: 'Clip', status: 'idle', content: 'clip.mp4' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('v->me', 'v', 'me')];

    const refs = deriveReferences('me', nodes, edges, NO_TEXT);
    expect(refs[0].sourceNodeType).toBe('video');
    expect(refs[0].thumbnail).toBeUndefined();
  });

  it('skips a dangling incoming edge whose source node no longer exists', () => {
    const nodes: CanvasNodeView[] = [
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('ghost->me', 'ghost', 'me')];

    expect(deriveReferences('me', nodes, edges, NO_TEXT)).toEqual([]);
  });

  it('reads a text source with no body entry as empty, not as a non-text source', () => {
    const nodes: CanvasNodeView[] = [
      node('txt', { kind: 'text', name: 'Notes', status: 'idle' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('txt->me', 'txt', 'me')];

    // An empty string and `undefined` mean different things downstream: the
    // serializer substitutes a chip's text, and the execute gate treats "@ a
    // non-empty text node" as a valid prompt on its own.
    const refs = deriveReferences('me', nodes, edges, new Map());
    expect(refs[0].textContent).toBe('');
  });

  it('leaves thumbnail undefined for a source node with no visual payload (text)', () => {
    const nodes: CanvasNodeView[] = [
      node('txt', { kind: 'text', name: 'Notes', status: 'idle' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [edge('txt->me', 'txt', 'me')];

    const refs = deriveReferences('me', nodes, edges, NO_TEXT);
    expect(refs[0].sourceNodeType).toBe('text');
    expect(refs[0].thumbnail).toBeUndefined();
  });

  // Text-chip serialization + hover (spec §9.1): a text reference carries its
  // source node's live text body so the prompt serializer can substitute the
  // chip with the content and the rail hover can preview it. Since #1774 the
  // body is a shared fragment the node view does not carry, so it arrives as
  // a separate map — a text source with no entry reads as empty rather than
  // as "not a text node".
  it('carries the text body for a text source (textContent), nothing for other kinds', () => {
    const nodes: CanvasNodeView[] = [
      node('txt', { kind: 'text', name: 'Notes', status: 'idle' }),
      node('img1', { kind: 'image', name: 'Pic', status: 'idle', content: 'x.png' }),
      node('me', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [
      edge('txt->me', 'txt', 'me', 1000),
      edge('img1->me', 'img1', 'me', 2000),
    ];

    const refs = deriveReferences(
      'me',
      nodes,
      edges,
      new Map([['txt', 'some words']]),
    );
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
      expect(deriveReferences('me', nodes, edges, NO_TEXT).map((r) => r.sourceNodeId)).toEqual([
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
      expect(deriveReferences('me', nodes, edges, NO_TEXT).map((r) => r.sourceNodeId)).toEqual([
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
      const fromScrambled = deriveReferences('me', nodes, scrambled, NO_TEXT).map((r) => r.refId);
      const fromReversed = deriveReferences('me', nodes, reversed, NO_TEXT).map((r) => r.refId);
      expect(fromScrambled).toEqual(fromReversed);
      expect(fromScrambled).toEqual(['a->me', 'b->me']);
    });

    it('breaks a same-millisecond stamp tie by edge id too', () => {
      const edges: CanvasEdge[] = [
        edge('c->me', 'c', 'me', 500),
        edge('b->me', 'b', 'me', 500),
      ];
      expect(deriveReferences('me', nodes, edges, NO_TEXT).map((r) => r.refId)).toEqual([
        'b->me',
        'c->me',
      ]);
    });

    it('does not mutate the caller-owned edges array while sorting', () => {
      const edges: CanvasEdge[] = [
        edge('c->me', 'c', 'me', 3000),
        edge('a->me', 'a', 'me', 1000),
      ];
      deriveReferences('me', nodes, edges, NO_TEXT);
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

    expect(deriveReferences('me', before, edges, NO_TEXT)[0].sourceNodeName).toBe('Old');
    expect(deriveReferences('me', after, edges, NO_TEXT)[0].sourceNodeName).toBe('Renamed');
  });
});

describe('deriveReferences — the media URL a hover preview can play (#1945)', () => {
  // `thumbnail` and `mediaUrl` are two different things and the rail needs
  // both: the 24×24 row image can only ever be a still, while the hover card
  // plays the asset itself. Deriving one from the other is what kept audio and
  // video references unplayable — `thumbnailOf` returns a video's COVER and
  // nothing at all for audio, on purpose, because feeding a raw video URL to
  // an `<img>` renders a broken image (#1821).
  it('carries the asset URL for image / audio / video, alongside the thumbnail', () => {
    const nodes: CanvasNodeView[] = [
      node('img1', {
        kind: 'image',
        name: 'Hero',
        status: 'idle',
        content: 'https://cdn/hero.png',
      }),
      node('aud1', {
        kind: 'audio',
        name: 'Narration',
        status: 'idle',
        content: 'https://cdn/voice.m4a',
      }),
      node('vid1', {
        kind: 'video',
        name: 'Clip',
        status: 'idle',
        content: 'https://cdn/clip.mp4',
        coverUrl: 'https://cdn/clip-cover.jpg',
      }),
      node('gen', { kind: 'image', name: 'Target', status: 'idle' }),
    ];
    const edges: CanvasEdge[] = [
      edge('e1', 'img1', 'gen', 1),
      edge('e2', 'aud1', 'gen', 2),
      edge('e3', 'vid1', 'gen', 3),
    ];
    const rail = deriveReferences('gen', nodes, edges, NO_TEXT);
    expect(
      rail.map((r) => ({
        kind: r.sourceNodeType,
        thumbnail: r.thumbnail,
        mediaUrl: r.mediaUrl,
      })),
    ).toEqual([
      {
        kind: 'image',
        thumbnail: 'https://cdn/hero.png',
        mediaUrl: 'https://cdn/hero.png',
      },
      // Audio has no still to show in the row, but it has something to play.
      {
        kind: 'audio',
        thumbnail: undefined,
        mediaUrl: 'https://cdn/voice.m4a',
      },
      // Video shows its cover in the row and plays the file in the card.
      {
        kind: 'video',
        thumbnail: 'https://cdn/clip-cover.jpg',
        mediaUrl: 'https://cdn/clip.mp4',
      },
    ]);
  });

  it('leaves mediaUrl unset for modalities with nothing to play', () => {
    const nodes: CanvasNodeView[] = [
      node('txt1', { kind: 'text', name: 'Script', status: 'idle' }),
      node('gen', { kind: 'video', name: 'Target', status: 'idle' }),
    ];
    const rail = deriveReferences(
      'gen',
      nodes,
      [edge('e1', 'txt1', 'gen', 1)],
      new Map([['txt1', 'a wide shot']]),
    );
    expect(rail[0]?.mediaUrl).toBeUndefined();
    expect(rail[0]?.textContent).toBe('a wide shot');
  });

  it('leaves mediaUrl unset while the source has not produced anything yet', () => {
    const nodes: CanvasNodeView[] = [
      node('vid1', { kind: 'video', name: 'Empty', status: 'idle' }),
      node('gen', { kind: 'video', name: 'Target', status: 'idle' }),
    ];
    const rail = deriveReferences(
      'gen',
      nodes,
      [edge('e1', 'vid1', 'gen', 1)],
      NO_TEXT,
    );
    expect(rail[0]?.mediaUrl).toBeUndefined();
    expect(rail[0]?.thumbnail).toBeUndefined();
  });
});
