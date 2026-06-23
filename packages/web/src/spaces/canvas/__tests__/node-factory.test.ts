// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  createEmptyNode,
  createGroupNode,
  CREATABLE_NODE_TYPES,
  isCreatableNodeType,
} from '@web/spaces/canvas/node-factory';

describe('createGroupNode — Group node factory', () => {
  it('builds a group node with stored width/height + Group default name, no childIds', () => {
    const f = createGroupNode('f1', { x: 10, y: 20 }, 300, 200, 'user-1');
    expect(f.id).toBe('f1');
    expect(f.type).toBe('group');
    expect(f.position).toEqual({ x: 10, y: 20 });
    expect(f.data.width).toBe(300);
    expect(f.data.height).toBe(200);
    expect(f.data.name).toBe('Group');
    expect(f.data.createdBy).toBe('user-1');
    expect(f.data.locked).toBe(false);
  });
});

describe('createEmptyNode — empty content node factory', () => {
  const pos = { x: 12, y: 34 };

  it('builds a CanvasNodeFields with the required data fields at their empty defaults', () => {
    const node = createEmptyNode('image', pos, 'user-1');
    expect(node.type).toBe('image');
    expect(node.position).toEqual(pos);
    expect(node.data.createdBy).toBe('user-1');
    expect(node.data.locked).toBe(false);
    expect(node.data.operationLocks).toEqual([]);
    expect(node.data.state).toBe('idle');
    expect(node.data.attachments).toEqual([]);
    expect(typeof node.data.createdAt).toBe('number');
    expect(node.data.createdAt).toBeGreaterThan(0);
  });

  it('sets a fixed English modality name (data value, not a localized label)', () => {
    expect(createEmptyNode('text', pos, 'u').data.name).toBe('Text');
    expect(createEmptyNode('image', pos, 'u').data.name).toBe('Image');
    expect(createEmptyNode('audio', pos, 'u').data.name).toBe('Audio');
    expect(createEmptyNode('video', pos, 'u').data.name).toBe('Video');
  });

  it('generates a unique non-empty id per call', () => {
    const a = createEmptyNode('text', pos, 'u');
    const b = createEmptyNode('text', pos, 'u');
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it('leaves content / coverUrl / Generate inputs unset on an empty node', () => {
    const node = createEmptyNode('image', pos, 'u');
    expect(node.data.content).toBeUndefined();
    expect(node.data.coverUrl).toBeUndefined();
    expect(node.data.prompt).toBeUndefined();
    expect(node.data.model).toBeUndefined();
  });

  it('defaults state to idle, but accepts an initial handling state (upload node)', () => {
    expect(createEmptyNode('image', pos, 'u').data.state).toBe('idle');
    expect(createEmptyNode('image', pos, 'u', 'handling').data.state).toBe(
      'handling',
    );
  });
});

describe('CREATABLE_NODE_TYPES + isCreatableNodeType', () => {
  it('lists exactly the 4 content modalities a user can create as an empty node', () => {
    expect([...CREATABLE_NODE_TYPES]).toEqual(['text', 'image', 'audio', 'video']);
  });

  it('narrows the 4 creatable types and rejects the rest', () => {
    expect(isCreatableNodeType('text')).toBe(true);
    expect(isCreatableNodeType('image')).toBe(true);
    expect(isCreatableNodeType('audio')).toBe(true);
    expect(isCreatableNodeType('video')).toBe(true);
    // 3d / web exist as modalities but are not offered as creation entries;
    // annotation / group are not content nodes; junk is rejected.
    expect(isCreatableNodeType('3d')).toBe(false);
    expect(isCreatableNodeType('web')).toBe(false);
    expect(isCreatableNodeType('annotation')).toBe(false);
    expect(isCreatableNodeType('group')).toBe(false);
    expect(isCreatableNodeType('nonsense')).toBe(false);
  });
});
