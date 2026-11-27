// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { captureClipboard, cloneForPaste, parseClipboard, serializeClipboard } from '@web/spaces/canvas/node-clipboard';
import { restoreNodeMedia } from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';

const PROJECT = 'origin-project';
const SPACE = 'origin-space';
const ORIGIN = { kind: 'mini-tool-output', runId: '10000000-0000-4000-8000-000000000001', planFingerprint: 'a'.repeat(64), outputIndex: 0 } as const;
const MEDIA = { coverUrl: 'https://assets.example.test/result.png', mediaWidth: 960, mediaHeight: 540, duration: 5.005, mimeType: 'video/webm', size: 1588436 };

/** Attach the raw node maps before setting the original media and running-state fields. */
function original(content = 'https://assets.example.test/result.webm'): Y.Map<unknown> {
  const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
  const node = new Y.Map<unknown>(); doc.getMap('nodesMap').set('original-node', node);
  node.set('type', 'video');
  const data = new Y.Map<unknown>(); node.set('data', data);
  for (const [key, value] of Object.entries({ name: 'MATTE', content, ...MEDIA, miniToolResultOrigin: ORIGIN, taskResultEventId: '100-0', taskCounts: { running: 0, done: 1, failed: 0, expired: 0 }, locked: false })) data.set(key, value);
  return data;
}

afterEach(() => { _resetForTests(); });

describe('planned media origin on real clipboard and history paths', () => {
  it('P09 carries media through copy/paste while excluding the original run marker from the fresh node', () => {
    const data = original(); const before = data.toJSON();
    const captured = captureClipboard(['original-node'], [{ id: 'original-node', type: 'video', position: { x: 10, y: 20 } }], () => data.toJSON(), [], { projectId: PROJECT, spaceId: SPACE });
    const parsed = parseClipboard(serializeClipboard(captured));
    expect(parsed).toEqual(captured);
    const clones = cloneForPaste(parsed!, 'copy-user', { dx: 24, dy: 24 });
    expect(clones.nodes).toHaveLength(1);
    const clone = clones.nodes[0]!;
    expect(clone.id).not.toBe('original-node'); expect(clones.idMap.get('original-node')).toBe(clone.id);
    expect(clone.data).toMatchObject({ content: 'https://assets.example.test/result.webm', ...MEDIA, name: 'COPY-MATTE', createdBy: 'copy-user', locked: false });
    expect(clone.data).not.toHaveProperty('miniToolResultOrigin');
    expect(clone.data).not.toHaveProperty('taskResultEventId'); expect(clone.data).not.toHaveProperty('taskCounts');
    expect(data.toJSON()).toEqual(before);
  });

  it('P09 excludes the marker and planned media state when the copied target is still empty', () => {
    const data = original('');
    const captured = captureClipboard(['original-node'], [{ id: 'original-node', type: 'video', position: { x: 0, y: 0 } }], () => data.toJSON(), [], { projectId: PROJECT, spaceId: SPACE });
    const clone = cloneForPaste(captured, 'copy-user', { dx: 0, dy: 0 }).nodes[0]!;
    expect(clone.data).not.toHaveProperty('miniToolResultOrigin'); expect(clone.data).not.toHaveProperty('taskCounts');
    expect(clone.data).not.toHaveProperty('taskResultEventId');
    for (const key of ['coverUrl', 'mediaWidth', 'mediaHeight', 'duration', 'mimeType', 'size']) expect(clone.data).not.toHaveProperty(key);
    expect(data.get('miniToolResultOrigin')).toEqual(ORIGIN);
  });

  it('P07 real history restoration changes media while preserving the first-handled run marker', () => {
    const data = original();
    restoreNodeMedia(PROJECT, SPACE, 'original-node', { content: 'https://assets.example.test/history.mp4', media: { coverUrl: 'https://assets.example.test/history.png', width: 640, height: 360, duration: 2, mimeType: 'video/mp4', size: 2048 } });
    expect(data.toJSON()).toMatchObject({ content: 'https://assets.example.test/history.mp4', coverUrl: 'https://assets.example.test/history.png', mediaWidth: 640, mediaHeight: 360, duration: 2, mimeType: 'video/mp4', size: 2048, miniToolResultOrigin: ORIGIN, taskResultEventId: '100-0', taskCounts: { running: 0, done: 1, failed: 0, expired: 0 } });
  });
});
