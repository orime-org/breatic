// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import {
  deriveStatus,
  isContentNodeView,
  toNodeView,
} from '@web/spaces/canvas/types/node-view';

/**
 * Builds a minimal valid wire {@link CanvasNodeFields} fixture so each test
 * only spells out the fields it cares about.
 * @param type - The node modality (wire `type`).
 * @param data - Partial data overrides merged onto the required-field defaults.
 * @returns A complete CanvasNodeFields object.
 */
function fields(
  type: NodeType,
  data: Partial<CanvasNodeFields['data']> = {},
): CanvasNodeFields {
  return {
    id: 'n1',
    type,
    position: { x: 0, y: 0 },
    data: {
      name: 'N',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
      ...data,
    },
  };
}

describe('toNodeView — wire CanvasNodeFields → narrowed view', () => {
  it('maps text content + derives idle status', () => {
    const v = toNodeView(fields('text', { content: 'hello' }));
    expect(v).toEqual({
      kind: 'text',
      content: 'hello',
      status: 'idle',
      errorMessage: undefined,
      locked: false,
    });
  });

  it('defaults missing text content to an empty string', () => {
    const v = toNodeView(fields('text', {}));
    expect(v).toMatchObject({ kind: 'text', content: '' });
  });

  it('maps the image content URL', () => {
    const v = toNodeView(fields('image', { content: 'u.jpg' }));
    expect(v).toMatchObject({ kind: 'image', content: 'u.jpg' });
  });

  it('passes audio duration through as seconds', () => {
    const v = toNodeView(fields('audio', { content: 'a.mp3', duration: 12 }));
    expect(v).toMatchObject({ kind: 'audio', content: 'a.mp3', duration: 12 });
  });

  it('maps video content, cover, and duration', () => {
    const v = toNodeView(
      fields('video', { content: 'v.mp4', coverUrl: 'c.jpg', duration: 30 }),
    );
    expect(v).toMatchObject({
      kind: 'video',
      content: 'v.mp4',
      coverUrl: 'c.jpg',
      duration: 30,
    });
  });

  it('maps the 3d model URL', () => {
    const v = toNodeView(fields('3d', { content: 'm.glb' }));
    expect(v).toMatchObject({ kind: '3d', content: 'm.glb' });
  });

  it('maps the web page URL', () => {
    const v = toNodeView(fields('web', { content: 'https://e.com' }));
    expect(v).toMatchObject({ kind: 'web', content: 'https://e.com' });
  });

  it('maps annotation text/author/createdAt to content/createdBy/createdAt(number)', () => {
    const v = toNodeView(
      fields('annotation', {
        content: 'please center this',
        createdBy: 'alice',
        createdAt: 5,
      }),
    );
    expect(v).toEqual({
      kind: 'annotation',
      content: 'please center this',
      createdBy: 'alice',
      createdAt: 5,
      locked: false,
    });
  });

  it('maps the locked flag through to every view kind', () => {
    expect(toNodeView(fields('image', { locked: true }))).toMatchObject({
      kind: 'image',
      locked: true,
    });
    expect(toNodeView(fields('annotation', { locked: true }))).toMatchObject({
      kind: 'annotation',
      locked: true,
    });
  });

  it('projects Generate inputs (prompt/model/generateMode) onto a content view', () => {
    // Model revision 2026-06-15: Generate is a toolbar action; its inputs
    // (prompt/model/sub-mode) live on the content node. Wire `kind` (the
    // generate sub-mode) projects to view `generateMode` to avoid colliding
    // with the view's `kind` modality discriminant.
    const v = toNodeView(
      fields('image', {
        content: 'x.png',
        prompt: 'a cat',
        model: 'flux-dev',
        kind: 'text-to-image',
      }),
    );
    expect(v).toMatchObject({
      kind: 'image',
      content: 'x.png',
      prompt: 'a cat',
      model: 'flux-dev',
      generateMode: 'text-to-image',
    });
  });

  it('returns a group view for group nodes (backgroundColor / childIds)', () => {
    // Model revision 2026-06-15: group is rendered (core feature), so it now
    // has a view instead of being skipped.
    const v = toNodeView(
      fields('group', { backgroundColor: '#eef', childIds: ['a', 'b'] }),
    );
    expect(v).toMatchObject({
      kind: 'group',
      backgroundColor: '#eef',
      childIds: ['a', 'b'],
    });
  });

  it('returns null for a dirty / unknown type instead of throwing', () => {
    const dirty = { ...fields('text', {}), type: 'bogus' as unknown as NodeType };
    expect(toNodeView(dirty)).toBeNull();
  });
});

describe('deriveStatus — wire state + errorMessage → 3-state display status', () => {
  it('handling state maps to handling', () => {
    expect(deriveStatus({ state: 'handling' })).toBe('handling');
  });

  it('idle with an errorMessage maps to error', () => {
    expect(deriveStatus({ state: 'idle', errorMessage: 'boom' })).toBe('error');
  });

  it('idle with no errorMessage maps to idle', () => {
    expect(deriveStatus({ state: 'idle' })).toBe('idle');
  });

  it('handling wins even if an errorMessage lingers', () => {
    expect(deriveStatus({ state: 'handling', errorMessage: 'old' })).toBe(
      'handling',
    );
  });
});

describe('isContentNodeView', () => {
  it('is true for the 6 content modalities', () => {
    const v = toNodeView(fields('image', { content: 'x' }));
    expect(v).not.toBeNull();
    expect(isContentNodeView(v!)).toBe(true);
  });

  it('is false for an annotation sticky', () => {
    const v = toNodeView(fields('annotation', { content: 'hi' }));
    expect(v).not.toBeNull();
    expect(isContentNodeView(v!)).toBe(false);
  });
});
