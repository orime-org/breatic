// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  CLIPBOARD_MARKER,
  serializeNodes,
  parseClipboardNodes,
  cloneForPaste,
  captureClipboard,
  clipboardBoundingBox,
  externalParentAbs,
  pasteAnchorOffset,
  textToNode,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';

describe('node-clipboard', () => {
  it('serializeNodes + parseClipboardNodes round-trip through the marker', () => {
    const nodes: ClipboardNode[] = [
      { type: 'text', position: { x: 1, y: 2 }, name: 'A', content: 'hi' },
    ];
    const serialized = serializeNodes(nodes);
    expect(serialized.startsWith(CLIPBOARD_MARKER)).toBe(true);
    expect(parseClipboardNodes(serialized)).toEqual(nodes);
  });

  it('parseClipboardNodes returns null for plain text and for non-JSON after the marker', () => {
    expect(parseClipboardNodes('just some pasted text')).toBeNull();
    expect(parseClipboardNodes(`${CLIPBOARD_MARKER}not json`)).toBeNull();
    expect(parseClipboardNodes(`${CLIPBOARD_MARKER}{"not":"array"}`)).toBeNull();
  });

  it('cloneForPaste: fresh unique ids, offset positions (relative preserved), carried content/name, fresh metadata', () => {
    const src: ClipboardNode[] = [
      { type: 'image', position: { x: 10, y: 20 }, name: 'Hero', content: 'a.png' },
      { type: 'text', position: { x: 30, y: 40 }, content: 'note' },
    ];
    const cloned = cloneForPaste(src, 'u-7', { dx: 24, dy: 24 });

    expect(cloned).toHaveLength(2);
    expect(cloned[0].id).toBeTruthy();
    expect(cloned[0].id).not.toBe(cloned[1].id);
    expect(cloned[0].type).toBe('image');
    expect(cloned[0].position).toEqual({ x: 34, y: 44 });
    // Both shifted by the same offset → relative layout preserved.
    expect(cloned[1].position).toEqual({ x: 54, y: 64 });
    // A top-level clone is a "root" → its name gets the COPY- prefix (R2-C).
    expect(cloned[0].data.name).toBe('COPY-Hero');
    expect(cloned[0].data.content).toBe('a.png');
    expect(cloned[0].data.createdBy).toBe('u-7');
    expect(cloned[0].data.state).toBe('idle');
    expect(cloned[0].data.locked).toBe(false);
    expect(typeof cloned[0].data.createdAt).toBe('number');
  });

  it('captureClipboard: a top-level content node → absolute position + id, no parent', () => {
    const out = captureClipboard(
      ['n'],
      [{ id: 'n', type: 'image', position: { x: 5, y: 6 }, data: { name: 'Hero', content: 'a.png' } }],
    );
    expect(out).toEqual([
      { type: 'image', position: { x: 5, y: 6 }, name: 'Hero', content: 'a.png', id: 'n' },
    ]);
  });

  it('captureClipboard: records a content node size from its measured size (for paste centering)', () => {
    const out = captureClipboard(
      ['n'],
      [
        {
          id: 'n',
          type: 'image',
          position: { x: 5, y: 6 },
          measured: { width: 300, height: 200 },
          data: {},
        },
      ],
    );
    expect(out[0].width).toBe(300);
    expect(out[0].height).toBe(200);
  });

  it('captureClipboard: a lone group member → absolute position + parentId kept (so duplicate can rejoin)', () => {
    const nodes = [
      { id: 'g', type: 'group', position: { x: 100, y: 100 }, data: { width: 200, height: 200 } },
      { id: 'm', type: 'text', parentId: 'g', position: { x: 20, y: 30 }, data: { content: 'hi' } },
    ];
    // member is captured alone (group not selected) → abs = group(100,100)+rel(20,30).
    expect(captureClipboard(['m'], nodes)).toEqual([
      { type: 'text', position: { x: 120, y: 130 }, content: 'hi', id: 'm', parentId: 'g' },
    ]);
  });

  it('captureClipboard: a group → group entry (abs + size) + every member (abs + parentId), members deduped', () => {
    const nodes = [
      {
        id: 'g',
        type: 'group',
        position: { x: 100, y: 100 },
        data: { name: 'My Group', width: 300, height: 200, backgroundColor: 'status-info' },
      },
      { id: 'm1', type: 'text', parentId: 'g', position: { x: 20, y: 30 }, data: { content: 'a' } },
      { id: 'm2', type: 'image', parentId: 'g', position: { x: 60, y: 40 }, data: {} },
    ];
    // Selecting the group AND a member must not emit the member twice; the
    // group's name is carried (R2-B — a duplicated group keeps its name).
    const out = captureClipboard(['g', 'm1'], nodes);
    expect(out).toEqual([
      {
        type: 'group',
        position: { x: 100, y: 100 },
        name: 'My Group',
        width: 300,
        height: 200,
        backgroundColor: 'status-info',
        id: 'g',
      },
      { type: 'text', position: { x: 120, y: 130 }, content: 'a', id: 'm1', parentId: 'g' },
      { type: 'image', position: { x: 160, y: 140 }, id: 'm2', parentId: 'g' },
    ]);
  });

  it('captureClipboard: skips non-copyable nodes (annotation / group with no group selected stays content-only)', () => {
    const out = captureClipboard(
      ['a'],
      [{ id: 'a', type: 'annotation', position: { x: 0, y: 0 }, data: {} }],
    );
    expect(out).toEqual([]);
  });

  it('externalParentAbs: maps a member parentId that is NOT a group in the payload to the existing group abs', () => {
    const payload: ClipboardNode[] = [
      { type: 'text', position: { x: 120, y: 130 }, id: 'm', parentId: 'g' },
    ];
    const allNodes = [
      { id: 'g', type: 'group', position: { x: 100, y: 100 } },
      { id: 'm', type: 'text', parentId: 'g', position: { x: 20, y: 30 } },
    ];
    expect(externalParentAbs(payload, allNodes)).toEqual(
      new Map([['g', { x: 100, y: 100 }]]),
    );
  });

  it('externalParentAbs: a LOCKED existing group is excluded → the lone-member clone stays top-level (Bug A)', () => {
    const payload: ClipboardNode[] = [
      { type: 'text', position: { x: 120, y: 130 }, id: 'm', parentId: 'g' },
    ];
    const allNodes = [
      { id: 'g', type: 'group', position: { x: 100, y: 100 }, data: { locked: true } },
      { id: 'm', type: 'text', parentId: 'g', position: { x: 20, y: 30 } },
    ];
    // The group is locked (frozen membership) → it must NOT take the duplicate,
    // so it is left out of the map and cloneForPaste makes the clone top-level.
    expect(externalParentAbs(payload, allNodes)).toEqual(new Map());
  });

  it('externalParentAbs: a member whose group IS in the payload is NOT external (empty map)', () => {
    const payload: ClipboardNode[] = [
      { type: 'group', position: { x: 100, y: 100 }, width: 200, height: 200, id: 'g' },
      { type: 'text', position: { x: 120, y: 130 }, id: 'm', parentId: 'g' },
    ];
    expect(externalParentAbs(payload, [])).toEqual(new Map());
  });

  it('cloneForPaste: a group + members → fresh group id, members rehomed to it, relative layout preserved', () => {
    const payload: ClipboardNode[] = [
      { type: 'group', position: { x: 100, y: 100 }, width: 300, height: 200, id: 'g' },
      { type: 'text', position: { x: 120, y: 130 }, content: 'a', id: 'm1', parentId: 'g' },
    ];
    const cloned = cloneForPaste(payload, 'u-1', { dx: 24, dy: 24 });
    expect(cloned).toHaveLength(2);
    const [group, member] = cloned;
    expect(group.type).toBe('group');
    // group shifts by the offset
    expect(group.position).toEqual({ x: 124, y: 124 });
    expect(group.parentId).toBeUndefined();
    expect(group.data.width).toBe(300);
    // member rehomes to the FRESH group id, relative position unchanged (offset cancels)
    expect(member.parentId).toBe(group.id);
    expect(member.parentId).not.toBe('g');
    expect(member.position).toEqual({ x: 20, y: 30 });
    expect(member.data.content).toBe('a');
  });

  it('cloneForPaste: COPY- prefix goes on roots only — a cloned group gets it, its following members do NOT (R2-C)', () => {
    const payload: ClipboardNode[] = [
      { type: 'group', position: { x: 100, y: 100 }, name: 'My Group', width: 300, height: 200, id: 'g' },
      { type: 'text', position: { x: 120, y: 130 }, name: 'Note', id: 'm1', parentId: 'g' },
    ];
    const cloned = cloneForPaste(payload, 'u-1', { dx: 24, dy: 24 });
    const [group, member] = cloned;
    // the group is a root → prefixed
    expect(group.data.name).toBe('COPY-My Group');
    // the member follows its cloned group → name unchanged (not prefixed)
    expect(member.data.name).toBe('Note');
  });

  it('cloneForPaste: a clone is always unlocked, even when the source was locked (R2-F)', () => {
    // The clipboard payload never carries `locked`, so a clone is always
    // unlocked — duplicating a locked node yields an editable copy.
    const payload: ClipboardNode[] = [
      { type: 'group', position: { x: 0, y: 0 }, width: 100, height: 100, id: 'g' },
      { type: 'text', position: { x: 10, y: 10 }, id: 'm', parentId: 'g' },
    ];
    const cloned = cloneForPaste(payload, 'u-1', { dx: 24, dy: 24 });
    for (const node of cloned) {
      expect(node.data.locked).toBe(false);
    }
  });

  it('cloneForPaste: an external-parent (lone member) clone is a root → COPY- prefixed (R2-C)', () => {
    const payload: ClipboardNode[] = [
      { type: 'text', position: { x: 120, y: 130 }, name: 'Note', id: 'm', parentId: 'g' },
    ];
    const cloned = cloneForPaste(payload, 'u-1', { dx: 24, dy: 24 }, new Map([['g', { x: 100, y: 100 }]]));
    expect(cloned[0].data.name).toBe('COPY-Note');
  });

  it('cloneForPaste: a lone member with an external parent rejoins that existing group, relative +offset', () => {
    const payload: ClipboardNode[] = [
      { type: 'text', position: { x: 120, y: 130 }, content: 'hi', id: 'm', parentId: 'g' },
    ];
    const cloned = cloneForPaste(payload, 'u-1', { dx: 24, dy: 24 }, new Map([['g', { x: 100, y: 100 }]]));
    expect(cloned).toHaveLength(1);
    // keeps the EXISTING group id; relative = (120,130)+offset − group(100,100) = (44,54)
    expect(cloned[0].parentId).toBe('g');
    expect(cloned[0].position).toEqual({ x: 44, y: 54 });
  });

  it('cloneForPaste: a lone member WITHOUT an external parent map becomes top-level (paste re-anchors)', () => {
    const payload: ClipboardNode[] = [
      { type: 'text', position: { x: 120, y: 130 }, content: 'hi', id: 'm', parentId: 'g' },
    ];
    const cloned = cloneForPaste(payload, 'u-1', { dx: 24, dy: 24 });
    expect(cloned[0].parentId).toBeUndefined();
    expect(cloned[0].position).toEqual({ x: 144, y: 154 });
  });

  it('textToNode builds a text node carrying the pasted text + empty-node defaults', () => {
    const node = textToNode('pasted words', { x: 5, y: 6 }, 'u-9');
    expect(node.type).toBe('text');
    expect(node.position).toEqual({ x: 5, y: 6 });
    expect(node.data.content).toBe('pasted words');
    expect(node.data.createdBy).toBe('u-9');
    expect(node.data.name).toBe('Text');
    expect(node.data.state).toBe('idle');
  });
});

describe('pasteAnchorOffset — viewport-aware Cmd+V placement (R2-H, Figma-style)', () => {
  // A 1000x800 viewport at flow origin.
  const viewport = { x: 0, y: 0, width: 1000, height: 800 };

  it('anchor inside the viewport → paste next to it (+offset)', () => {
    expect(pasteAnchorOffset({ x: 500, y: 400 }, viewport, 24)).toEqual({
      dx: 24,
      dy: 24,
    });
  });

  it('a box fully off-screen (zoom-independent) recenters, no longer nudged off-screen', () => {
    // top-left (1200,400) is past the right edge (1000) and the box has no size,
    // so it does not overlap the viewport → recenter (the old 50%-inflated rule
    // wrongly nudged it +24 and left it off-screen).
    expect(pasteAnchorOffset({ x: 1200, y: 400 }, viewport, 24)).toEqual({
      dx: 500 - 1200,
      dy: 400 - 400,
    });
  });

  it('a box that still partly overlaps the viewport pastes beside it (+offset)', () => {
    // box spans x 900..1100 — its left half is inside the 0..1000 viewport → in view.
    expect(
      pasteAnchorOffset({ x: 900, y: 400, width: 200, height: 100 }, viewport, 24),
    ).toEqual({ dx: 24, dy: 24 });
  });

  it('anchor far outside (scrolled away) → paste at the viewport center', () => {
    // anchor at (5000,5000) is well past the 50%-larger area → recenter.
    // viewport center = (500,400); offset = center − anchor.
    expect(pasteAnchorOffset({ x: 5000, y: 5000 }, viewport, 24)).toEqual({
      dx: 500 - 5000,
      dy: 400 - 5000,
    });
  });

  it('off-view recenter centers the bounding box, not its top-left', () => {
    // bbox 5000..5300 × 5000..5200 → center (5150, 5100); viewport center
    // (500, 400) → offset moves the bbox center to the viewport center.
    expect(
      pasteAnchorOffset({ x: 5000, y: 5000, width: 300, height: 200 }, viewport, 24),
    ).toEqual({ dx: 500 - 5150, dy: 400 - 5100 });
  });

  it('a degenerate (zero-area) viewport falls back to the in-place nudge', () => {
    // No layout measured yet (jsdom / pre-mount) → can't recenter, so nudge.
    expect(pasteAnchorOffset({ x: 999, y: 999 }, { x: 0, y: 0, width: 0, height: 0 }, 24)).toEqual({
      dx: 24,
      dy: 24,
    });
  });

  it('recenter works with a non-origin viewport', () => {
    const vp = { x: 2000, y: 1000, width: 1000, height: 800 };
    // center = (2500,1400); anchor (0,0) far outside → offset = center − anchor.
    expect(pasteAnchorOffset({ x: 0, y: 0 }, vp, 24)).toEqual({ dx: 2500, dy: 1400 });
  });
});

describe('clipboardBoundingBox — the payload bounding box for viewport-center paste (R2-H)', () => {
  it('unions position + size across all nodes', () => {
    const box = clipboardBoundingBox([
      { type: 'image', position: { x: 0, y: 0 }, width: 100, height: 50 },
      { type: 'text', position: { x: 200, y: 100 }, width: 80, height: 40 },
    ]);
    // x 0..280, y 0..140
    expect(box).toEqual({ x: 0, y: 0, width: 280, height: 140 });
  });

  it('falls back to the empty-node footprint for a node carrying no size', () => {
    const box = clipboardBoundingBox([{ type: 'text', position: { x: 10, y: 20 } }]);
    // a content node with no recorded size uses EMPTY_NODE_SIZE (288 × 192).
    expect(box).toEqual({ x: 10, y: 20, width: 288, height: 192 });
  });

  it('a single sized node → its own rect', () => {
    expect(
      clipboardBoundingBox([{ type: 'group', position: { x: 5, y: 6 }, width: 300, height: 200 }]),
    ).toEqual({ x: 5, y: 6, width: 300, height: 200 });
  });
});
