// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import {
  type CanvasNodeFields,
  type NodeTaskCounts,
  type NodeType,
} from '@breatic/shared';

import {
  deriveStatus,
  isContentNodeView,
  toNodeView,
} from '@web/spaces/canvas/types/node-view';

/**
 * Builds a minimal valid wire `CanvasNodeFields` fixture so each test
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
      state: 'idle',
      attachments: [],
      ...data,
    },
  };
}

/**
 * Builds the four task counts a node projects, so each test only names the
 * ones it is about.
 * @param over - The counts this test cares about; the rest are zero.
 * @returns A complete set of four counts.
 */
function counts(over: Partial<NodeTaskCounts> = {}): NodeTaskCounts {
  return { running: 0, done: 0, failed: 0, expired: 0, ...over };
}

describe('toNodeView — wire CanvasNodeFields → narrowed view', () => {
  // The body stays OUT of the projection (#1774). That absence is what makes a
  // keystroke change nothing the canvas mirror compares, so zero nodes
  // re-render while somebody types; project it here and that guarantee is gone
  // board-wide. Anything displaying the text subscribes through `useTextBody`.
  it('projects a text node without its body, whatever the wire data carries', () => {
    const v = toNodeView(fields('text', { content: 'hello' }));
    expect(v).toEqual({
      kind: 'text',
      name: 'N',
      status: 'idle',
      errorMessage: undefined,
      locked: false,
    });
  });

  it('projects data.name onto a content view (drives the node name header)', () => {
    const v = toNodeView(fields('image', { content: 'x', name: 'My Pic' }));
    expect(v).toMatchObject({ kind: 'image', name: 'My Pic' });
  });

  it('projects the four task counts onto a content view (#186 §7.1)', () => {
    // The counts column outside the node reads them straight off the view;
    // they are the whole of what the document says about its tasks.
    const counts = { running: 2, done: 1, failed: 0, expired: 3 };
    const v = toNodeView(fields('image', { content: 'x', taskCounts: counts }));

    expect(v).toMatchObject({ kind: 'image', taskCounts: counts });
  });

  it('leaves no body field behind on a text node', () => {
    const v = toNodeView(fields('text', {}));
    expect(v).not.toHaveProperty('content');
    expect(v).not.toHaveProperty('body');
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

  it('names nobody on a node with a task running (#186)', () => {
    // The document says how many tasks are in each state and nothing else, so
    // who started one is not on the node at all — the task list answers that.
    const v = toNodeView(
      fields('image', { taskCounts: counts({ running: 1 }) }),
    );
    expect(v).toMatchObject({ status: 'handling' });
    expect(v).not.toHaveProperty('handlingByUserId');
  });

  it('projects Generate inputs (prompt/model/mode/modelByMode) onto a content view', () => {
    // Model revision 2026-06-15: Generate is a toolbar action; its inputs
    // (prompt / model / mode / modelByMode / paramsByModel) live on the
    // content node and project onto the view. The panel reads them via the view
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

  it('projects focus images onto a content view (#1782 focus slice)', () => {
    // Focus crops are standalone copies stored on the node itself (no
    // upstream relationship) — the panel reads them via the view for the
    // reference rail's focus entries + the @ mention pool.
    const crop = {
      id: 'f1',
      url: 'https://cdn/crop.png',
      name: 'Image Node 26',
      width: 640,
      height: 360,
    };
    const v = toNodeView(fields('image', { focusImages: [crop] }));
    expect(v).toMatchObject({ kind: 'image', focusImages: [crop] });
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

describe('deriveStatus — task counts → 3-state display status (#186 §7.6)', () => {
  it('shows the loading branch while any task is still running', () => {
    expect(
      deriveStatus({ taskCounts: counts({ running: 1 }) }),
    ).toBe('handling');
  });

  it('keeps showing loading when an earlier task already failed', () => {
    // A node may carry several tasks at once. One of them having failed says
    // nothing about the one still writing to this node.
    expect(
      deriveStatus({ taskCounts: counts({ running: 1, failed: 2 }) }),
    ).toBe('handling');
  });

  it('shows the error branch once the last task failed and nothing landed', () => {
    expect(deriveStatus({ taskCounts: counts({ failed: 1 }) })).toBe('error');
  });

  it('shows the error branch for a task judged expired', () => {
    expect(deriveStatus({ taskCounts: counts({ expired: 1 }) })).toBe('error');
  });

  it('shows the error branch for the local text extraction that failed', () => {
    // `data.errorMessage` survives as the one field the browser still writes,
    // and only for the extraction that never reaches the task table (§3.7.4).
    expect(deriveStatus({ errorMessage: 'boom' })).toBe('error');
  });

  it('shows the content once a task landed something, failures and all', () => {
    // One upload failed, another succeeded. What the node shows is the
    // content; the failure is a row in the task list.
    expect(
      deriveStatus({
        taskCounts: counts({ done: 1, failed: 1 }),
        content: 'https://cdn.invalid/out.png',
      }),
    ).toBe('idle');
  });

  it('shows nothing for a node whose tasks all finished', () => {
    expect(deriveStatus({ taskCounts: counts({ done: 2 }) })).toBe('idle');
  });

  it('shows nothing for a node that has never carried a task', () => {
    expect(deriveStatus({})).toBe('idle');
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
