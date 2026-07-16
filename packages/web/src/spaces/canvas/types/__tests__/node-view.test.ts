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
      name: 'N',
      content: 'hello',
      status: 'idle',
      errorMessage: undefined,
      locked: false,
    });
  });

  it('projects data.name onto a content view (drives the node name header)', () => {
    const v = toNodeView(fields('image', { content: 'x', name: 'My Pic' }));
    expect(v).toMatchObject({ kind: 'image', name: 'My Pic' });
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

  it('projects Generate inputs (prompt/model/mode/modelByMode) onto a content view', () => {
    // Model revision 2026-06-15: Generate is a toolbar action; its inputs
    // (prompt / model / params / mode / modelByMode) live on the content node
    // and project onto the view. The Generate panel reads them via the view
    // (panel-view-model consumes `CanvasNodeView.data` = this view) and writes
    // back to the wire through the canvas-space setters. `mode` is the
    // generation sub-mode (image: t2i / i2i); `modelByMode` is the per-mode
    // model memory.
    const v = toNodeView(
      fields('image', {
        content: 'x.png',
        prompt: 'a cat',
        model: 'flux-dev',
        mode: 't2i',
        modelByMode: { t2i: 'flux-dev', i2i: 'flux-redux' },
      }),
    );
    expect(v).toMatchObject({
      kind: 'image',
      content: 'x.png',
      prompt: 'a cat',
      model: 'flux-dev',
      mode: 't2i',
      modelByMode: { t2i: 'flux-dev', i2i: 'flux-redux' },
    });
  });

  it('projects the style image URL onto a content view (image-node style slice #1664)', () => {
    // The style reference is a pick-time COPY of the source image URL stored on
    // the node itself (no upstream relationship) — the panel reads it via the
    // view for the Style tool slot + the execute payload's params.style_images.
    const v = toNodeView(
      fields('image', { styleImageUrl: 'https://cdn/style.png' }),
    );
    expect(v).toMatchObject({ kind: 'image', styleImageUrl: 'https://cdn/style.png' });
  });

  it('returns a group view for group nodes (name / backgroundColor)', () => {
    // Group is rendered (core feature); the group header shows `name`. Members
    // bind back via their own parentId, so the view carries no childIds.
    const v = toNodeView(
      fields('group', {
        name: 'My Group',
        backgroundColor: '#eef',
      }),
    );
    expect(v).toMatchObject({
      kind: 'group',
      name: 'My Group',
      backgroundColor: '#eef',
    });
  });

  it('carries a group node authoritative width/height into the view', () => {
    // Group redesign (2026-06-23): a group stores its own canvas footprint in
    // width/height; the view surfaces them so GroupNode renders at that size
    // instead of deriving the box from members.
    const v = toNodeView(
      fields('group', { name: 'My Group', width: 400, height: 300 }),
    );
    expect(v).toMatchObject({ kind: 'group', width: 400, height: 300 });
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

  it('handling past the lease budget derives error — display-level timeout fallback (#1569)', () => {
    // The collab sweeper is the authority that WRITES the timeout back to
    // Yjs; this is only the render-side safety net so a viewer never stares
    // at an hours-old skeleton while the sweep is pending. Clock injected
    // for determinism.
    const startedAt = 1_700_000_000_000;
    const withinBudget = startedAt + 3_599_000;
    const pastBudget = startedAt + 3_600_001;
    const data = {
      state: 'handling' as const,
      handlingBy: { userId: 'u1', type: 'frontend' as const, startedAt, gen: 1 },
    };
    expect(deriveStatus(data, withinBudget)).toBe('handling');
    expect(deriveStatus(data, pastBudget)).toBe('error');
  });

  it('handling with no handlingBy stays handling at the display level (sweeper owns reclaiming legacy zombies)', () => {
    // Pre-#1569 zombie nodes have state='handling' with no handlingBy at
    // all. The display keeps showing handling (no lease to measure); the
    // collab sweeper reclaims them server-side.
    expect(deriveStatus({ state: 'handling' }, Number.MAX_SAFE_INTEGER)).toBe(
      'handling',
    );
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
