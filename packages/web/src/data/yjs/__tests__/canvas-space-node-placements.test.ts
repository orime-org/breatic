// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the document says about where each node sits and what decides its size
 * (inner#1443): the facts a proposal reads to find a clear spot.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { CanvasNodeFields } from '@breatic/shared';

import { _resetForTests } from '@web/data/yjs/manager';
import { addNode, readNodePlacements } from '@web/data/yjs/canvas-space';

const PID = 'p1';
const SID = 's1';

/**
 * A node to write, with only the fields these cases read.
 * @param fields - The node's id, type, position and data.
 * @returns The node as the document stores it.
 */
const node = (fields: Partial<CanvasNodeFields> & Pick<CanvasNodeFields, 'id' | 'type'>): CanvasNodeFields =>
  ({
    position: { x: 0, y: 0 },
    ...fields,
    data: { name: fields.id, locked: false, createdBy: 'u1', ...(fields.data ?? {}) },
  }) as CanvasNodeFields;

beforeEach(() => {
  _resetForTests();
});

describe('readNodePlacements', () => {
  it('places a group member at its group position plus its own', () => {
    addNode(PID, SID, node({ id: 'g', type: 'group', position: { x: 100, y: 200 }, data: { width: 600, height: 400 } as never }));
    addNode(PID, SID, node({ id: 'm', type: 'image', parentId: 'g', position: { x: 10, y: 20 } }));

    const member = readNodePlacements(PID, SID).find((p) => p.id === 'm');
    expect(member).toMatchObject({ x: 110, y: 220, type: 'image' });
  });

  it('carries a group own width and height', () => {
    addNode(PID, SID, node({ id: 'g', type: 'group', position: { x: 0, y: 0 }, data: { width: 600, height: 400 } as never }));

    expect(readNodePlacements(PID, SID)[0]).toMatchObject({ width: 600, height: 400 });
  });

  it('carries the pixel size of a picture', () => {
    addNode(PID, SID, node({ id: 'i', type: 'image', data: { mediaWidth: 1080, mediaHeight: 1920 } as never }));

    expect(readNodePlacements(PID, SID)[0]).toMatchObject({ mediaWidth: 1080, mediaHeight: 1920 });
  });

  it('carries a text node words as plain text', () => {
    addNode(PID, SID, node({ id: 't', type: 'text', data: { content: 'first line\nsecond line' } as never }));

    expect(readNodePlacements(PID, SID)[0]?.bodyText).toBe('first line\nsecond line');
  });
});
