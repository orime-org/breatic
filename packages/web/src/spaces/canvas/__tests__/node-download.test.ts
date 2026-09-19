// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #2108 — which nodes offer Download, and what it hands over.
 *
 * The rule under test is the reader's: a node showing content can be
 * downloaded, one showing an error box or an empty frame cannot. These pin
 * both halves of the answer at once, since the menu item's presence and its
 * target come from the same call.
 */

import { describe, it, expect } from 'vitest';
import { downloadableAsset } from '@web/spaces/canvas/node-download';
import type { NodeView } from '@web/data/yjs/node-view';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

const ASSET = 'https://assets.example.com/image/2026-09-13/a.png';

describe('the asset a node offers for download', () => {
  it('is the image a filled image node is showing', () => {
    const node: NodeView = { kind: 'image', status: 'idle', content: ASSET };

    expect(downloadableAsset(node, false)).toBe(ASSET);
  });

  it('is the file a filled video node is showing', () => {
    const node: NodeView = { kind: 'video', status: 'idle', content: ASSET };

    expect(downloadableAsset(node, false)).toBe(ASSET);
  });

  it('is the file a filled audio node is showing', () => {
    const node: NodeView = { kind: 'audio', status: 'idle', content: ASSET };

    expect(downloadableAsset(node, false)).toBe(ASSET);
  });

  it('is nothing on an empty node', () => {
    const node: NodeView = { kind: 'image', status: 'idle' };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('is nothing when the node holds an empty address', () => {
    const node: NodeView = { kind: 'image', status: 'idle', content: '' };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('is nothing on a node showing an error box', () => {
    const node: NodeView = { kind: 'image', status: 'error', content: ASSET };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('is the content again once the task list opens beside a failed node', () => {
    // The error box steps aside for the body while that list is open
    // (`showsErrorBox`), so what the reader sees is the image again.
    const node: NodeView = { kind: 'image', status: 'error', content: ASSET };

    expect(downloadableAsset(node, true)).toBe(ASSET);
  });

  it('is the content a node keeps showing while a task writes to it', () => {
    const node: NodeView = { kind: 'video', status: 'handling', content: ASSET };

    expect(downloadableAsset(node, false)).toBe(ASSET);
  });

  it('is still nothing when an empty node has a task running', () => {
    const node: NodeView = { kind: 'audio', status: 'handling' };

    expect(downloadableAsset(node, false)).toBeNull();
  });
});

describe('the modalities that offer download', () => {
  it('leaves out a text node', () => {
    const node: NodeView = { kind: 'text', status: 'idle' };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('leaves out a 3d node', () => {
    const node: NodeView = { kind: '3d', status: 'idle', content: ASSET };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('leaves out a web node', () => {
    const node: NodeView = { kind: 'web', status: 'idle', content: ASSET };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('leaves out a group container', () => {
    const node: NodeView = { kind: 'group' };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('leaves out an annotation sticky', () => {
    const node: NodeView = {
      kind: 'annotation',
      content: 'a remark',
      createdBy: 'u-1',
      createdAt: 0,
      replies: [],
    };

    expect(downloadableAsset(node, false)).toBeNull();
  });

  it('is nothing when the canvas holds no such node', () => {
    expect(downloadableAsset(undefined, false)).toBeNull();
  });
});

describe('the label on the menu item', () => {
  it('is translated in every locale we ship', () => {
    // A key present only in English renders in English everywhere else, and
    // nothing goes red: `t` falls back rather than failing. So the catalogs
    // are read directly, the way `audio-slots.test.ts` reads them.
    for (const [locale, catalog] of LOCALE_CATALOGS) {
      expect(
        readPath(catalog, 'canvas.nodeMenu.download'),
        `${locale} is missing canvas.nodeMenu.download`,
      ).toBeTypeOf('string');
    }
  });
});
