// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import {
  type CanvasNodeFields,
  type NodeTaskCounts,
  type NodeType,
} from '@breatic/shared';

import {
  deriveHandling,
  toNodeView,
} from '@web/data/yjs/node-view';

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

describe('toNodeView — the node type is kept once (inner#1456)', () => {
  const ALL_TYPES: readonly NodeType[] = ['text', 'image', 'audio', 'video', '3d', 'web', 'annotation', 'group'];

  it.each(ALL_TYPES)('pairs a %s node with its view, which carries no copy of the type', (type) => {
    const typed = toNodeView(fields(type));

    expect(typed?.type).toBe(type);
    expect(typed?.data).toBeDefined();
    expect(typed?.data).not.toHaveProperty('kind');
  });
});

describe('toNodeView — wire CanvasNodeFields → narrowed view', () => {
  // The body stays OUT of the projection (#1774). That absence is what makes a
  // keystroke change nothing the canvas mirror compares, so zero nodes
  // re-render while somebody types; project it here and that guarantee is gone
  // board-wide. Anything displaying the text subscribes through `useTextBody`.
  it('projects a text node without its body, whatever the wire data carries', () => {
    const v = toNodeView(fields('text', { content: 'hello' }));
    expect(v).toEqual({
      type: 'text',
      data: {
        name: 'N',
        handling: false,
        locked: false,
      },
    });
  });

  it('projects data.name onto a content view (drives the node name header)', () => {
    const v = toNodeView(fields('image', { content: 'x', name: 'My Pic' }));
    expect(v).toMatchObject({ type: 'image', data: { name: 'My Pic' } });
  });

  // A text node's body is always there to show — an empty one is a paragraph
  // somebody can type into — so it has no "nothing to display" state to fall
  // into. A failed run on it shows in the counts column beside it and in the
  // row that failed, and the body stays readable and editable.
  it('leaves a text node idle when a run on it failed', () => {
    const counts = { running: 0, done: 0, failed: 1, expired: 0 };
    expect(toNodeView(fields('text', { taskCounts: counts }))).toMatchObject({
      type: 'text',
      data: {
        handling: false,
      },
    });
  });

  // inner#888 §7.8: a node shows no task state. Failures live in the counts
  // column and the task list; text this browser could not extract is a toast.
  it('carries no display status on any node, whatever its tasks did', () => {
    const failed = counts({ failed: 1, expired: 1 });
    for (const type of ['image', 'video', 'audio', 'text'] as const) {
      const view = toNodeView(fields(type, { taskCounts: failed }))?.data;
      expect(view).toMatchObject({ handling: false });
      expect(view).not.toHaveProperty('status');
    }
  });

  it('projects what the ledger settled the file as onto a content view', () => {
    // The Understand gate reads both off the view before it builds anything.
    // A node stored before the ledger reported them carries neither, and the
    // gate is silent rather than refusing — so this has to distinguish a
    // value that arrived from one that never did.
    const v = toNodeView(
      fields('audio', { content: 'x', mimeType: 'audio/wav', size: 1_048_576 }),
    );
    expect(v).toMatchObject({ type: 'audio', data: { mimeType: 'audio/wav', sizeBytes: 1_048_576 } });

    const bare = toNodeView(fields('audio', { content: 'x' }));
    expect(bare).toMatchObject({ type: 'audio', data: { mimeType: undefined, sizeBytes: undefined } });
  });

  it('projects the four task counts onto a content view (#186 §7.1)', () => {
    // The counts column outside the node reads them straight off the view;
    // they are the whole of what the document says about its tasks.
    const counts = { running: 2, done: 1, failed: 0, expired: 3 };
    const v = toNodeView(fields('image', { content: 'x', taskCounts: counts }));

    expect(v).toMatchObject({ type: 'image', data: { taskCounts: counts } });
  });

  it('leaves no body field behind on a text node', () => {
    const v = toNodeView(fields('text', {}))?.data;
    expect(v).not.toHaveProperty('content');
    expect(v).not.toHaveProperty('body');
  });

  it('maps the image content URL', () => {
    const v = toNodeView(fields('image', { content: 'u.jpg' }));
    expect(v).toMatchObject({ type: 'image', data: { content: 'u.jpg' } });
  });

  it('carries the ledger dimensions onto image and video views (#209)', () => {
    expect(
      toNodeView(fields('image', { content: 'u.jpg', mediaWidth: 1920, mediaHeight: 1080 })),
    ).toMatchObject({ type: 'image', data: { width: 1920, height: 1080 } });
    expect(
      toNodeView(fields('video', { content: 'v.mp4', mediaWidth: 640, mediaHeight: 360 })),
    ).toMatchObject({ type: 'video', data: { width: 640, height: 360 } });
  });

  it('does not read a footprint as if it were the media resolution', () => {
    // `width` / `height` on a node's data are a Group's own canvas footprint,
    // which is a number the user dragged to. Reading one onto a media view
    // would put "400×300" in the resolution badge of an image that is not
    // 400×300, so the two are separate fields.
    const v = toNodeView(
      fields('image', { content: 'u.jpg', width: 400, height: 300 }),
    );
    expect(v).toMatchObject({ type: 'image', data: { width: undefined, height: undefined } });
  });

  it('passes audio duration through as seconds', () => {
    const v = toNodeView(fields('audio', { content: 'a.mp3', duration: 12 }));
    expect(v).toMatchObject({ type: 'audio', data: { content: 'a.mp3', duration: 12 } });
  });

  it('maps video content, cover, and duration', () => {
    const v = toNodeView(
      fields('video', { content: 'v.mp4', coverUrl: 'c.jpg', duration: 30 }),
    );
    expect(v).toMatchObject({
      type: 'video',
      data: {
        content: 'v.mp4',
        coverUrl: 'c.jpg',
        duration: 30,
      },
    });
  });

  it('maps the 3d model URL', () => {
    const v = toNodeView(fields('3d', { content: 'm.glb' }));
    expect(v).toMatchObject({ type: '3d', data: { content: 'm.glb' } });
  });

  it('maps the web page URL', () => {
    const v = toNodeView(fields('web', { content: 'https://e.com' }));
    expect(v).toMatchObject({ type: 'web', data: { content: 'https://e.com' } });
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
      type: 'annotation',
      data: {
        content: 'please center this',
        createdBy: 'alice',
        createdAt: 5,
        // Never edited, so no mark to draw; nobody replied, so an empty list
        // rather than an absent one the renderer would have to guard.
        editedAt: undefined,
        replies: [],
        locked: false,
      },
    });
  });

  it('carries an annotation replies and its edited stamp through', () => {
    const v = toNodeView(
      fields('annotation', {
        content: 'a cooler shot here',
        createdBy: 'alice',
        createdAt: 5,
        editedAt: 9,
        replies: [
          {
            id: 'r1',
            content: 'agreed, slower',
            createdBy: 'bob',
            createdAt: 7,
          },
        ],
      }),
    );
    expect(v?.data).toMatchObject({
      editedAt: 9,
      replies: [{ id: 'r1', content: 'agreed, slower', createdBy: 'bob' }],
    });
  });

  it('hands the replies back oldest first, whatever order the document holds', () => {
    // Two people replying in the same sync window converge on an order Yjs
    // decides from their client ids, not from the clock: measured on yjs
    // 13.6.32, the same pair of pushes lands `newer, older` one way round and
    // `older, newer` with the ids swapped. The reader is promised time order,
    // so it is settled here rather than in the document.
    const v = toNodeView(
      fields('annotation', {
        content: 'a cooler shot here',
        createdBy: 'alice',
        createdAt: 5,
        replies: [
          { id: 'r2', content: 'second', createdBy: 'bob', createdAt: 20 },
          { id: 'r1', content: 'first', createdBy: 'cara', createdAt: 10 },
        ],
      }),
    );
    expect(v?.data).toMatchObject({ replies: [{ id: 'r1' }, { id: 'r2' }] });
  });

  it('settles replies stamped the same millisecond the same way everywhere', () => {
    // Two clients would otherwise draw them in whichever order their own
    // document happened to hold, and the two boards would disagree.
    const same = (order: readonly string[]): unknown =>
      toNodeView(
        fields('annotation', {
          content: 'a cooler shot here',
          createdBy: 'alice',
          createdAt: 5,
          replies: order.map((id) => ({
            id,
            content: id,
            createdBy: 'bob',
            createdAt: 10,
          })),
        }),
      )?.data;
    expect(same(['rb', 'ra'])).toMatchObject({
      replies: [{ id: 'ra' }, { id: 'rb' }],
    });
    expect(same(['ra', 'rb'])).toMatchObject({
      replies: [{ id: 'ra' }, { id: 'rb' }],
    });
  });

  it('maps the locked flag through to every view type', () => {
    expect(toNodeView(fields('image', { locked: true }))).toMatchObject({
      type: 'image',
      data: {
        locked: true,
      },
    });
    expect(toNodeView(fields('annotation', { locked: true }))).toMatchObject({
      type: 'annotation',
      data: {
        locked: true,
      },
    });
  });

  it('names nobody on a node with a task running (#186)', () => {
    // The document says how many tasks are in each state and nothing else, so
    // who started one is not on the node at all — the task list answers that.
    const v = toNodeView(
      fields('image', { taskCounts: counts({ running: 1 }) }),
    );
    expect(v?.data).toMatchObject({ handling: true });
    expect(v?.data).not.toHaveProperty('handlingByUserId');
  });

  it('projects Generate inputs (model/mode/modelByMode) onto a content view', () => {
    // Model revision 2026-06-15: Generate is a toolbar action; its inputs
    // (model / mode / modelByMode / paramsByModel) live on the
    // content node and project onto the view. The panel reads them via the view
    // (panel-view-model consumes `CanvasNodeView.data` = this view) and writes
    // back to the wire through the canvas-space setters. `mode` is the
    // generation sub-mode (image: t2i / i2i); `modelByMode` is the per-mode
    // model memory.
    const v = toNodeView(
      fields('image', {
        content: 'x.png',
        model: 'flux-dev',
        mode: 't2i',
        modelByMode: { t2i: 'flux-dev', i2i: 'flux-redux' },
      }),
    );
    expect(v).toMatchObject({
      type: 'image',
      data: {
        content: 'x.png',
        model: 'flux-dev',
        mode: 't2i',
        modelByMode: { t2i: 'flux-dev', i2i: 'flux-redux' },
      },
    });
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
    expect(v).toMatchObject({ type: 'image', data: { focusImages: [crop] } });
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
      type: 'group',
      data: {
        name: 'My Group',
        backgroundColor: '#eef',
      },
    });
  });

  it('carries a group node authoritative width/height into the view', () => {
    // Group redesign (2026-06-23): a group stores its own canvas footprint in
    // width/height; the view surfaces them so GroupNode renders at that size
    // instead of deriving the box from members.
    const v = toNodeView(
      fields('group', { name: 'My Group', width: 400, height: 300 }),
    );
    expect(v).toMatchObject({ type: 'group', data: { width: 400, height: 300 } });
  });

  it('returns null for a dirty / unknown type instead of throwing', () => {
    const dirty = { ...fields('text', {}), type: 'bogus' as unknown as NodeType };
    expect(toNodeView(dirty)).toBeNull();
  });
});

describe('deriveHandling — is a task writing to this node (inner#888 §7.8)', () => {
  it('is true while any task is still running', () => {
    expect(deriveHandling({ taskCounts: counts({ running: 1 }) })).toBe(true);
  });

  it('stays true when an earlier task already failed', () => {
    // A node may carry several tasks at once. One of them having failed says
    // nothing about the one still writing to this node.
    expect(
      deriveHandling({ taskCounts: counts({ running: 1, failed: 2 }) }),
    ).toBe(true);
  });

  it('is false once nothing runs, failures and expiries included', () => {
    expect(deriveHandling({ taskCounts: counts({ failed: 1 }) })).toBe(false);
    expect(deriveHandling({ taskCounts: counts({ expired: 1 }) })).toBe(false);
  });

  it('is false for a node that has never carried a task', () => {
    expect(deriveHandling({})).toBe(false);
  });
});

describe('toNodeView — the template node a node stands for (inner#1345)', () => {
  it('carries a template node tag onto a content view', () => {
    const v = toNodeView(fields('image', { templateNode: { template: 'fx', key: 'up' } }));

    expect(v?.type === 'image' ? v.data.templateNode : 'not an image view').toEqual({ template: 'fx', key: 'up' });
  });

  it('carries a guide text node tag with the anchor node id', () => {
    const v = toNodeView(fields('text', { templateNode: { template: 'fx', key: 'guide', anchor: 'anchor-1' } }));

    expect(v?.type === 'text' ? v.data.templateNode : 'not a text view').toEqual({
      template: 'fx',
      key: 'guide',
      anchor: 'anchor-1',
    });
  });

  it('leaves the tag out of a node that stands for no template node', () => {
    const v = toNodeView(fields('image'));

    expect(v?.type === 'image' ? v.data.templateNode : 'not an image view').toBeUndefined();
  });
});
