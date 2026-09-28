// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A slot keeps how long its clip or track runs (#2156, design §14), so a model
 * priced by the second can show a price rather than "at least".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode } from '@web/data/yjs/canvas-space';
import { fillSlot } from '@web/spaces/canvas/generate/slot-write';
import { readSlotDurations } from '@web/spaces/canvas/generate/slots';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';

const PID = 'p1';
const SID = 's1';

/**
 * The generative node's data map, as the panels read it.
 * @returns A plain snapshot of node `gen`'s data.
 */
function genData(): Record<string, unknown> {
  const node = getDoc(docName.canvasSpace(PID, SID)).getMap<Y.Map<unknown>>('nodesMap').get('gen');
  return (node?.get('data') as Y.Map<unknown>).toJSON();
}

describe('a slot keeps its source length', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, {
      id: 'gen',
      type: 'video',
      position: { x: 0, y: 0 },
      data: { name: 'V', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
    });
  });

  it('stores the clicked clip length with the pick and reads it back per slot', () => {
    const clip = { type: 'video', data: { content: 'https://cdn/c.mp4', coverUrl: 'https://cdn/c.png', duration: 7.5 } };
    expect(fillSlot(PID, SID, 'gen', VIDEO_SLOTS.drivingVideo, clip)).toBe(true);
    expect(genData()[VIDEO_SLOTS.drivingVideo.field]).toEqual({
      url: 'https://cdn/c.mp4',
      cover: 'https://cdn/c.png',
      duration: 7.5,
    });
    expect(readSlotDurations(VIDEO_SLOTS, genData())).toEqual({ drivingVideo: 7.5 });
  });

  it('stores no length the node does not know, and reads none back', () => {
    for (const duration of [undefined, 0, -3, Number.NaN, '7']) {
      const clip = { type: 'video', data: { content: 'https://cdn/c.mp4', duration } };
      fillSlot(PID, SID, 'gen', VIDEO_SLOTS.drivingVideo, clip);
      expect(genData()[VIDEO_SLOTS.drivingVideo.field]).toEqual({ url: 'https://cdn/c.mp4' });
      expect(readSlotDurations(VIDEO_SLOTS, genData())).toEqual({});
    }
  });
});
