// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  connectableCreatableTypes,
  isBlankCanvasRelease,
  resolveConnectCreateIntent,
} from '@web/spaces/canvas/lib/connect-create';

// Batch-2 item 3: dragging a wire from an OUTPUT stub and releasing over
// blank canvas offers a "create + connect" menu. Its rows = the creatable
// modalities (text/image/audio/video, library order) whose INPUT accepts the
// dragged source's kind (connection rules §9.1) — never a row that would be
// rejected the moment the edge is written.
describe('connectableCreatableTypes — creatable ∩ rule-compatible targets', () => {
  it('image source can feed text / image / video (audio accepts text only)', () => {
    expect(connectableCreatableTypes('image')).toEqual([
      'text',
      'image',
      'video',
    ]);
  });

  it('text source can feed all four creatable modalities', () => {
    expect(connectableCreatableTypes('text')).toEqual([
      'text',
      'image',
      'audio',
      'video',
    ]);
  });

  it('audio source can feed text / video only', () => {
    expect(connectableCreatableTypes('audio')).toEqual(['text', 'video']);
  });

  it('video source can feed text / video only', () => {
    expect(connectableCreatableTypes('video')).toEqual(['text', 'video']);
  });

  it('a source no creatable input accepts (3d / unknown) yields no rows', () => {
    // 3d / web ARE unrestricted as targets, but they are not creatable — and
    // no creatable modality's whitelist admits them as sources.
    expect(connectableCreatableTypes('3d')).toEqual([]);
    expect(connectableCreatableTypes('')).toEqual([]);
  });
});

// Adversarial (batch-2 round-1): the release element comes from
// document.elementFromPoint(release coords), NOT event.target — a touchend's
// target is the element the touch STARTED on (the handle), and mouse releases
// can land on invisible hit layers. This classifier decides what counts as
// "visually blank": inside the pane, not a node, not the floating panel.
describe('isBlankCanvasRelease — what counts as visually blank canvas', () => {
  /**
   * Builds a chain of nested divs (outermost first) and returns the innermost.
   * @param classes - Class names, outermost first ('' = no class).
   * @returns The innermost element.
   */
  function nested(...classes: string[]): Element {
    let parent: HTMLElement = document.createElement('div');
    const root = parent;
    for (const cls of classes) {
      const el = document.createElement('div');
      if (cls) el.className = cls;
      parent.appendChild(el);
      parent = el;
    }
    document.body.appendChild(root);
    return parent;
  }

  it('the bare pane is blank', () => {
    expect(isBlankCanvasRelease(nested('react-flow__pane'))).toBe(true);
  });

  it('an edge interaction stroke (invisible 20px hit layer) counts as blank', () => {
    expect(
      isBlankCanvasRelease(
        nested('react-flow__pane', 'react-flow__edge', 'react-flow__edge-interaction'),
      ),
    ).toBe(true);
  });

  it('the NodesSelection rect (post-marquee overlay over blank canvas) counts as blank', () => {
    expect(
      isBlankCanvasRelease(nested('react-flow__pane', 'react-flow__nodesselection')),
    ).toBe(true);
  });

  it('a node body is NOT blank', () => {
    expect(
      isBlankCanvasRelease(nested('react-flow__pane', 'react-flow__node', 'inner')),
    ).toBe(false);
  });

  it('the floating generate panel (NodeToolbar portal) is NOT blank', () => {
    expect(
      isBlankCanvasRelease(
        nested('react-flow__pane', 'react-flow__node-toolbar', 'panel-body'),
      ),
    ).toBe(false);
  });

  it('anything outside the pane (chrome, minimap panel, page) is NOT blank', () => {
    expect(isBlankCanvasRelease(nested('react-flow__panel', 'react-flow__minimap'))).toBe(
      false,
    );
    expect(isBlankCanvasRelease(nested('some-chrome'))).toBe(false);
    expect(isBlankCanvasRelease(null)).toBe(false);
  });
});

describe('resolveConnectCreateIntent — when a blank release opens the menu', () => {
  const base = {
    fromNodeId: 'a',
    fromNodeKind: 'image',
    fromHandleType: 'source' as string | null,
    toNodeId: null as string | null,
    releasedOnPane: true,
    readOnly: false,
  };

  it('opens for a source-handle drag released on the blank pane', () => {
    expect(resolveConnectCreateIntent(base)).toEqual({
      sourceId: 'a',
      sourceKind: 'image',
      types: ['text', 'image', 'video'],
    });
  });

  it('declines a drag that ended on a node (a normal connect / reject, not a create)', () => {
    expect(resolveConnectCreateIntent({ ...base, toNodeId: 'b' })).toBeNull();
  });

  it('declines a drag that started from an INPUT stub (only outputs create downstream)', () => {
    expect(
      resolveConnectCreateIntent({ ...base, fromHandleType: 'target' }),
    ).toBeNull();
  });

  it('declines a release over a node body / chrome (not the blank pane)', () => {
    expect(
      resolveConnectCreateIntent({ ...base, releasedOnPane: false }),
    ).toBeNull();
  });

  it('declines for a read-only viewer (cannot create nodes)', () => {
    expect(resolveConnectCreateIntent({ ...base, readOnly: true })).toBeNull();
  });

  it('declines when no creatable modality accepts the source (empty menu never opens)', () => {
    expect(
      resolveConnectCreateIntent({ ...base, fromNodeKind: '3d' }),
    ).toBeNull();
  });

  it('declines when the drag carries no source node (defensive)', () => {
    expect(
      resolveConnectCreateIntent({
        ...base,
        fromNodeId: null,
        fromNodeKind: undefined,
      }),
    ).toBeNull();
  });
});
