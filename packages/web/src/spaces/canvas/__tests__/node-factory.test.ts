// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  createEmptyGroup,
  createEmptyNode,
  CREATABLE_NODE_TYPES,
  isCreatableNodeType,
} from '@web/spaces/canvas/node-factory';

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
});

describe('createEmptyGroup — group node factory', () => {
  const pos = { x: 5, y: 6 };

  it('builds a group CanvasNodeFields wrapping the given child ids', () => {
    const g = createEmptyGroup(['a', 'b'], pos, 'user-1');
    expect(g.type).toBe('group');
    expect(g.position).toEqual(pos);
    expect(g.data.childIds).toEqual(['a', 'b']);
    expect(g.data.createdBy).toBe('user-1');
    expect(g.data.locked).toBe(false);
    expect(g.data.operationLocks).toEqual([]);
    expect(g.data.state).toBe('idle');
    expect(g.data.attachments).toEqual([]);
    expect(typeof g.data.createdAt).toBe('number');
    expect(g.data.createdAt).toBeGreaterThan(0);
  });

  it('defaults the name to the fixed English "Group" (not a localized label)', () => {
    expect(createEmptyGroup(['a'], pos, 'u').data.name).toBe('Group');
  });

  it('leaves backgroundColor unset by default (no color = neutral dashed frame)', () => {
    expect(createEmptyGroup(['a'], pos, 'u').data.backgroundColor).toBeUndefined();
  });

  it('generates a unique non-empty id per call', () => {
    const a = createEmptyGroup(['x'], pos, 'u');
    const b = createEmptyGroup(['x'], pos, 'u');
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it('copies childIds — later mutation of the caller array does not leak in', () => {
    const src = ['a', 'b'];
    const g = createEmptyGroup(src, pos, 'u');
    src.push('c');
    expect(g.data.childIds).toEqual(['a', 'b']);
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
