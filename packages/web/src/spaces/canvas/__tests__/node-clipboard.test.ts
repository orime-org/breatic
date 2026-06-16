// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  CLIPBOARD_MARKER,
  serializeNodes,
  parseClipboardNodes,
  cloneForPaste,
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
    expect(cloned[0].data.name).toBe('Hero');
    expect(cloned[0].data.content).toBe('a.png');
    expect(cloned[0].data.createdBy).toBe('u-7');
    expect(cloned[0].data.state).toBe('idle');
    expect(cloned[0].data.locked).toBe(false);
    expect(typeof cloned[0].data.createdAt).toBe('number');
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
