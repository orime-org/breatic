// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video focus crop, the panel node's state (frames-split design §5.5 "任务归属", "交付", §7.18; test plan §68.1).
 * The panel node keeps `focusCropOutcomes` (taskId → `added` | `refused`), the handled-crop marker collab writes beside
 * `focusImages`. The canvas layer reads it through `readNodes` → `toNodeView`'s `contentCommon`; it is task state, not
 * content, so a copy never carries it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY } from '@breatic/shared';
import { addNode, readNodes } from '@web/data/yjs/canvas-space';
import { destroyDoc, docName, getDoc } from '@web/data/yjs/manager';
import { captureClipboard, cloneForPaste } from '@web/spaces/canvas/node-clipboard';

const PROJECT = '20000000-0000-4000-8000-000000000001';
const SPACE = '20000000-0000-4000-8000-000000000002';
const PANEL = '20000000-0000-4000-8000-000000000003';
const RUN = '20000000-0000-4000-8000-000000000004';
const IMAGE = { id: '20000000-0000-4000-8000-000000000005', url: 'https://assets.example.test/image/crop.png', name: 'Clip 7', width: 960, height: 540 };
const COUNTS = { running: 0, done: 1, failed: 0, expired: 0 };

/**
 * The panel node's live data map.
 * @returns The map.
 * @throws {Error} When the node is missing.
 */
function panelData(): Y.Map<unknown> {
  const node = getDoc(docName.canvasSpace(PROJECT, SPACE)).getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get(PANEL);
  const data = node?.get('data');
  if (!(data instanceof Y.Map)) throw new Error('The panel node has no data map');
  return data;
}

/**
 * What the canvas layer reads for the panel node.
 * @returns The node's projected data.
 * @throws {Error} When the node is not projected.
 */
function panelView(): Record<string, unknown> {
  const node = readNodes(getDoc(docName.canvasSpace(PROJECT, SPACE))).find((one) => one.id === PANEL);
  if (!node) throw new Error('The panel node was not projected');
  return node.data as Record<string, unknown>;
}

beforeEach(() => {
  addNode(PROJECT, SPACE, { id: PANEL, type: 'image', position: { x: 0, y: 0 }, data: { content: '', name: 'Panel', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
});
afterEach(() => { destroyDoc(docName.canvasSpace(PROJECT, SPACE)); });

describe('focusCropOutcomes on the panel node (design §5.5, §7.18)', () => {
  it('F13: contentCommon projects focusCropOutcomes beside focusImages and taskCounts', () => {
    const data = panelData();
    data.set('focusImages', [IMAGE]);
    data.set('taskCounts', COUNTS);
    data.set('focusCropOutcomes', { [RUN]: 'added' });
    const view = panelView();
    expect(view.focusImages).toEqual([IMAGE]);
    expect(view.taskCounts).toEqual(COUNTS);
    expect(view.focusCropOutcomes).toEqual({ [RUN]: 'added' });
  });

  it('F08: a marker that lands without a counts change is visible to the canvas layer through readNodes', () => {
    const data = panelData();
    data.set('taskCounts', COUNTS);
    const before = panelView();
    expect(before.focusCropOutcomes).toBeUndefined();
    // collab writes only the marker: the counts it would republish are the same, so `taskCounts` is not written.
    data.set('focusCropOutcomes', { [RUN]: 'refused' });
    const after = panelView();
    expect(after.taskCounts).toEqual(before.taskCounts);
    expect(after.focusCropOutcomes).toEqual({ [RUN]: 'refused' });
  });

  it('F10: a panel node with a crop running is handling, so it is not a focus source', () => {
    panelData().set('taskCounts', { running: 1, done: 0, failed: 0, expired: 0 });
    expect(panelView().handling).toBe(true);
  });

  it('F12: copying the panel node carries its focus images but not focusCropOutcomes', () => {
    const data = panelData();
    data.set('focusImages', [IMAGE]);
    data.set('focusCropOutcomes', { [RUN]: 'added' });
    const captured = captureClipboard([PANEL], [{ id: PANEL, type: 'image', position: { x: 0, y: 0 } }], () => data.toJSON(), [], { projectId: PROJECT, spaceId: SPACE });
    const clone = cloneForPaste(captured, 'copy-user', { dx: 24, dy: 24 }).nodes[0]!;
    expect(clone.data).toMatchObject({ focusImages: [IMAGE] });
    expect(clone.data).not.toHaveProperty('focusCropOutcomes');
    expect(data.get('focusCropOutcomes')).toEqual({ [RUN]: 'added' });
  });
});
