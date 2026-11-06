// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 4: every canvas write function
 * goes through the size gateway with the kind design 5.2 gives it.
 *
 * add: blocked once the Space is full; overwrite: blocked only when the
 * overwrite room is gone; delete: never blocked outside a rebuild.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type CanvasNodeFields, type NodeMediaFields } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { estimateTextBodyBytes } from '@web/data/yjs/space-write';
import {
  addEdge,
  addNode,
  addNodeFocusImage,
  addReply,
  appendNodeSlotItem,
  createGroup,
  editAnnotationBody,
  editReply,
  ensureTextBody,
  expandGroup,
  readTextBodies,
  removeEdge,
  removeElements,
  removeNode,
  removeNodeFocusImage,
  removeNodeSlotItem,
  removeReply,
  resizeGroup,
  restoreNodeMedia,
  setGroupBackground,
  setNodeExtractedText,
  setNodeLocked,
  setNodeMode,
  setNodeModel,
  setNodeName,
  setNodeParams,
  setNodeParent,
  setNodePosition,
  setNodeSlotValue,
  setNodeTemplateNode,
  readEdges,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_FULL,
  F_FULL_NEAR,
  F_OVER_BIG,
  F_WARNING,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p1';
const SID = 's1';
const NAME = docName.canvasSpace(PID, SID);
const SLOT = 'reference_images';
const SLOT_ITEM = 'https://cdn.example.test/ref-1.png';
const FOCUS = { id: 'f1', url: 'https://cdn.example.test/focus-1.png', name: 'Focus', width: 64, height: 64 };

/**
 * Wire fields every seeded node carries.
 * @param id - Node id.
 * @param type - Node modality.
 * @param data - Extra data fields.
 * @returns The node.
 */
function node(id: string, type: string, data: Record<string, unknown> = {}): CanvasNodeFields {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1, createdBy: 'u1', locked: false, attachments: [], ...data },
  } as CanvasNodeFields;
}

/**
 * Seeds the section-4 board: text t1 (with body), group g1 (blue), video v1
 * (one slot item, one focus image), annotation a1 (reply r1), edge t1->v1,
 * and a text node tb whose body was never created. Written before any push,
 * while the size state is unknown and everything is allowed.
 * @returns The canvas document.
 * @throws {Error} When seeding fails.
 */
function seedBoard(): Y.Doc {
  const { doc } = openSizedDoc(NAME);
  addNode(PID, SID, node('t1', 'text', { content: 'hello' }));
  addNode(PID, SID, node('g1', 'group', { backgroundColor: 'blue', width: 400, height: 300 }));
  addNode(PID, SID, node('v1', 'video', { [SLOT]: [SLOT_ITEM], focusImages: [FOCUS], mode: 'text_to_video', model: 'm-old' }));
  addNode(PID, SID, node('a1', 'annotation', { content: 'note' }));
  addReply(PID, SID, 'a1', { id: 'r1', content: 'first', createdBy: 'u1', createdAt: 2 });
  addEdge(PID, SID, { id: 't1->v1', source: 't1', target: 'v1' });
  doc.transact(() => {
    const raw = new Y.Map<unknown>();
    raw.set('id', 'tb');
    raw.set('type', 'text');
    raw.set('position', { x: 0, y: 0 });
    const data = new Y.Map<unknown>();
    data.set('name', 'tb');
    raw.set('data', data);
    doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).set('tb', raw);
  });
  return doc;
}

/**
 * The data map of a node on the live document.
 * @param doc - Canvas document.
 * @param id - Node id.
 * @returns Its data map.
 * @throws {Error} When the node is missing.
 */
function data(doc: Y.Doc, id: string): Y.Map<unknown> {
  const map = doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get(id)?.get('data');
  if (!(map instanceof Y.Map)) throw new Error(`node ${id} has no data`);
  return map;
}

/**
 * Seeds the board and delivers one push.
 * @param push - The size push.
 * @returns The document after the push.
 * @throws {Error} When seeding fails.
 */
function boardAt(push: DocSizePush): Y.Doc {
  const doc = seedBoard();
  pushSize(sizeGateProviders.at(-1)!, push);
  vi.mocked(toast.warning).mockClear();
  return doc;
}

beforeEach(() => {
  sizeGateProviders.length = 0;
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.clearAllMocks();
});

describe('W-46 add-kind canvas writes are refused once the Space is full', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown, (doc: Y.Doc) => void]> = [
    ['addNode', () => addNode(PID, SID, node('n9', 'image')), (doc) => expect(doc.getMap(CANVAS_NODES_KEY).has('n9')).toBe(false)],
    ['createGroup', () => createGroup(PID, SID, node('g9', 'group', { width: 100, height: 100 }), [{ id: 't1', position: { x: 5, y: 5 } }]), (doc) => {
      expect(doc.getMap(CANVAS_NODES_KEY).has('g9')).toBe(false);
      expect(doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get('t1')!.has('parentId')).toBe(false);
    }],
    ['addEdge', () => addEdge(PID, SID, { id: 'v1->t1', source: 'v1', target: 't1' }), (doc) => expect(readEdges(doc).some((e) => e.id === 'v1->t1')).toBe(false)],
    ['addReply', () => addReply(PID, SID, 'a1', { id: 'r9', content: 'hi', createdBy: 'u1', createdAt: 3 }), (doc) => expect((data(doc, 'a1').get('replies') as Y.Array<unknown>).length).toBe(1)],
    ['editAnnotationBody', () => editAnnotationBody(PID, SID, 'a1', 'new', 4), (doc) => expect(data(doc, 'a1').get('content')).toBe('note')],
    ['editReply', () => editReply(PID, SID, 'a1', 'r1', 'new', 4), (doc) => expect(((data(doc, 'a1').get('replies') as Y.Array<Y.Map<unknown>>).get(0)).get('content')).toBe('first')],
    ['setNodeName', () => setNodeName(PID, SID, 't1', 'a longer name'), (doc) => expect(data(doc, 't1').get('name')).toBe('t1')],
    ['setNodeTemplateNode', () => setNodeTemplateNode(PID, SID, 't1', { template: 't', key: 'k' }), (doc) => expect(data(doc, 't1').has('templateNode')).toBe(false)],
    ['setNodeParams', () => setNodeParams(PID, SID, 'v1', { 'm-old': { duration: 8 } }), (doc) => expect(data(doc, 'v1').has('paramsByModel')).toBe(false)],
    ['setNodeSlotValue', () => setNodeSlotValue(PID, SID, 'v1', 'first_frame', 'https://cdn.example.test/url.png'), (doc) => expect(data(doc, 'v1').has('first_frame')).toBe(false)],
    ['appendNodeSlotItem', () => appendNodeSlotItem(PID, SID, 'v1', SLOT, 'https://cdn.example.test/ref-2.png', 4), (doc) => expect(data(doc, 'v1').get(SLOT)).toEqual([SLOT_ITEM])],
    ['addNodeFocusImage', () => addNodeFocusImage(PID, SID, 'v1', { ...FOCUS, id: 'f2' }), (doc) => expect((data(doc, 'v1').get('focusImages') as Y.Array<unknown>).toArray()).toEqual([FOCUS])],
    ['setNodeModel', () => setNodeModel(PID, SID, 'v1', 'text_to_video', 'm-new', {}), (doc) => expect(data(doc, 'v1').get('model')).toBe('m-old')],
    ['setNodeMode', () => setNodeMode(PID, SID, 'v1', 'image_to_video', 'm-new', {}), (doc) => expect(data(doc, 'v1').get('mode')).toBe('text_to_video')],
    ['ensureTextBody', () => ensureTextBody(PID, SID, 'tb'), (doc) => expect(data(doc, 'tb').has('body')).toBe(false)],
    ['setNodeExtractedText', () => setNodeExtractedText(PID, SID, 't1', 'abc'), () => expect(readTextBodies(PID, SID, ['t1']).get('t1')).toBe('hello')],
    ['restoreNodeMedia', () => restoreNodeMedia(PID, SID, 'v1', { content: 'https://cdn.example.test/v.mp4', media: { coverUrl: 'https://cdn.example.test/c.jpg', width: 10, height: 10, duration: 1, mimeType: 'video/mp4', size: 1 } satisfies NodeMediaFields }), (doc) => expect(data(doc, 'v1').has('content')).toBe(false)],
    ['setGroupBackground', () => setGroupBackground(PID, SID, 'g1', 'magenta'), (doc) => expect(data(doc, 'g1').get('backgroundColor')).toBe('blue')],
  ];

  it.each(cases)('%s writes nothing and warns once', (name, call, unchanged) => {
    const doc = boardAt(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    const result = call();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    unchanged(doc);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
    if (name === 'setNodeExtractedText' || name === 'addNode') expect(result).toEqual({ ok: false, reason: 'full' });
  });
});

describe('W-46b a write replacing a value is judged by what it adds over the value it replaces', () => {
  const LONG = 'n'.repeat(300);
  // Each seeds a long value while the size is unknown, then shortens it.
  const shorter: ReadonlyArray<readonly [string, () => void, () => void, (doc: Y.Doc) => unknown, unknown]> = [
    ['setNodeName', () => setNodeName(PID, SID, 't1', LONG), () => setNodeName(PID, SID, 't1', 'short'),
      (doc) => data(doc, 't1').get('name'), 'short'],
    ['editAnnotationBody', () => editAnnotationBody(PID, SID, 'a1', LONG, 3), () => editAnnotationBody(PID, SID, 'a1', 'short', 4),
      (doc) => data(doc, 'a1').get('content'), 'short'],
    ['editReply', () => editReply(PID, SID, 'a1', 'r1', LONG, 3), () => editReply(PID, SID, 'a1', 'r1', 'short', 4),
      (doc) => (data(doc, 'a1').get('replies') as Y.Array<Y.Map<unknown>>).get(0).get('content'), 'short'],
    ['setGroupBackground', () => undefined, () => setGroupBackground(PID, SID, 'g1', 'red'),
      (doc) => data(doc, 'g1').get('backgroundColor'), 'red'],
    ['setNodeParams', () => setNodeParams(PID, SID, 'v1', { 'm-old': { prompt: LONG } }), () => setNodeParams(PID, SID, 'v1', { 'm-old': {} }),
      (doc) => data(doc, 'v1').get('paramsByModel'), { 'm-old': {} }],
    ['setNodeSlotValue', () => setNodeSlotValue(PID, SID, 'v1', 'first_frame', `https://cdn.example.test/${LONG}.png`),
      () => setNodeSlotValue(PID, SID, 'v1', 'first_frame', 'https://cdn.example.test/a.png'),
      (doc) => data(doc, 'v1').get('first_frame'), 'https://cdn.example.test/a.png'],
    ['setNodeTemplateNode', () => setNodeTemplateNode(PID, SID, 't1', { template: LONG, key: 'k' }),
      () => setNodeTemplateNode(PID, SID, 't1', { template: 't', key: 'k' }),
      (doc) => data(doc, 't1').get('templateNode'), { template: 't', key: 'k' }],
    ['setNodeMode', () => setNodeMode(PID, SID, 'v1', 'text_to_video', 'm-old', { 'm-old': { prompt: LONG } }),
      () => setNodeMode(PID, SID, 'v1', 'image_to_video', 'm-old', {}),
      (doc) => data(doc, 'v1').get('mode'), 'image_to_video'],
    ['setNodeModel', () => setNodeModel(PID, SID, 'v1', 'text_to_video', 'm-old', { 'm-old': { prompt: LONG } }),
      () => setNodeModel(PID, SID, 'v1', 'text_to_video', 'm-new', {}),
      (doc) => data(doc, 'v1').get('model'), 'm-new'],
  ];

  /**
   * Seeds the board, writes the long value, then delivers one push.
   * @param seed - Writes the long value.
   * @param push - The size push.
   * @returns The document after the push.
   */
  function seededAt(seed: () => void, push: DocSizePush): Y.Doc {
    const doc = seedBoard();
    seed();
    pushSize(sizeGateProviders.at(-1)!, push);
    vi.mocked(toast.warning).mockClear();
    return doc;
  }

  it.each(shorter)('%s writes a shorter value at full as an overwrite', (_name, seed, call, read, after) => {
    const doc = seededAt(seed, F_FULL);
    call();
    expect(read(doc)).toEqual(after);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each(shorter)('%s is refused with the overwrite notice once the overwrite room is 0', (_name, seed, call) => {
    const doc = seededAt(seed, F_FULL_NEAR);
    const before = Y.encodeStateAsUpdate(doc);
    call();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_OVERWRITE_BLOCKED);
  });

  it('lets a one-character longer name in when the room covers the change but not the whole name', () => {
    const doc = seededAt(() => setNodeName(PID, SID, 't1', LONG), { ...F_WARNING, room: 100 });
    setNodeName(PID, SID, 't1', `${LONG}n`);
    expect(data(doc, 't1').get('name')).toBe(`${LONG}n`);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('refuses a longer name when the room is short of the change', () => {
    const doc = seededAt(() => setNodeName(PID, SID, 't1', 'short'), { ...F_WARNING, room: 100 });
    setNodeName(PID, SID, 't1', LONG);
    expect(data(doc, 't1').get('name')).toBe('short');
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

describe('W-47 add-kind canvas writes go through while the Space is only near full', () => {
  it('adds a node, renames, recolours and fills a slot without a toast', () => {
    const doc = boardAt(F_WARNING);
    addNode(PID, SID, node('n9', 'image'));
    setNodeName(PID, SID, 't1', 'x');
    setGroupBackground(PID, SID, 'g1', 'red');
    setNodeSlotValue(PID, SID, 'v1', 'first_frame', 'url');
    expect(doc.getMap(CANVAS_NODES_KEY).has('n9')).toBe(true);
    expect(data(doc, 't1').get('name')).toBe('x');
    expect(data(doc, 'g1').get('backgroundColor')).toBe('red');
    expect(data(doc, 'v1').get('first_frame')).toBe('url');
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-48 delete-kind canvas writes go through even over the hard ceiling', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown, (doc: Y.Doc) => void]> = [
    ['removeNode', () => removeNode(PID, SID, 't1'), (doc) => expect(doc.getMap(CANVAS_NODES_KEY).has('t1')).toBe(false)],
    ['removeElements', () => removeElements(PID, SID, ['g1'], []), (doc) => expect(doc.getMap(CANVAS_NODES_KEY).has('g1')).toBe(false)],
    ['removeEdge', () => removeEdge(PID, SID, 't1->v1'), (doc) => expect(readEdges(doc).some((e) => e.id === 't1->v1')).toBe(false)],
    ['removeReply', () => removeReply(PID, SID, 'a1', 'r1'), (doc) => expect((data(doc, 'a1').get('replies') as Y.Array<unknown>).length).toBe(0)],
    ['removeNodeSlotItem', () => removeNodeSlotItem(PID, SID, 'v1', SLOT, SLOT_ITEM), (doc) => expect(data(doc, 'v1').has(SLOT)).toBe(false)],
    ['removeNodeFocusImage', () => removeNodeFocusImage(PID, SID, 'v1', 'f1'), (doc) => expect((data(doc, 'v1').get('focusImages') as Y.Array<unknown>).length).toBe(0)],
    ['setNodeSlotValue(null)', () => setNodeSlotValue(PID, SID, 'v1', SLOT, null), (doc) => expect(data(doc, 'v1').has(SLOT)).toBe(false)],
    ['setGroupBackground(undefined)', () => setGroupBackground(PID, SID, 'g1', undefined), (doc) => expect(data(doc, 'g1').has('backgroundColor')).toBe(false)],
  ];

  it.each(cases)('%s removes the content without a toast', (_name, call, removed) => {
    const doc = boardAt(F_OVER_BIG);
    call();
    removed(doc);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-49 overwrite-kind canvas writes are refused only when the overwrite room is gone', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown, (doc: Y.Doc) => unknown, unknown, unknown]> = [
    ['setNodePosition', () => setNodePosition(PID, SID, 't1', { x: 500, y: 500 }, null),
      (doc) => doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get('t1')!.get('position'), { x: 500, y: 500 }, { x: 0, y: 0 }],
    ['resizeGroup', () => resizeGroup(PID, SID, 'g1', { x: 0, y: 0 }, 640, 480),
      (doc) => [data(doc, 'g1').get('width'), data(doc, 'g1').get('height')], [640, 480], [400, 300]],
    ['expandGroup', () => expandGroup(PID, SID, 'g1', { x: -10, y: -10 }, 700, 500),
      (doc) => [data(doc, 'g1').get('width'), data(doc, 'g1').get('height')], [700, 500], [400, 300]],
    ['setNodeParent', () => setNodeParent(PID, SID, 't1', 'g1', { x: 10, y: 10 }),
      (doc) => doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get('t1')!.get('parentId'), 'g1', undefined],
    ['setNodeLocked', () => setNodeLocked(PID, SID, 't1', true),
      (doc) => data(doc, 't1').get('locked'), true, false],
  ];

  it.each(cases)('%s goes through at full with overwrite room left', (_name, call, read, after) => {
    const doc = boardAt(F_FULL);
    call();
    expect(read(doc)).toEqual(after);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each(cases)('%s is refused once the overwrite room is 0', (_name, call, read, _after, original) => {
    const doc = boardAt(F_FULL_NEAR);
    const before = Y.encodeStateAsUpdate(doc);
    call();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(read(doc)).toEqual(original);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_OVERWRITE_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-50 setNodeExtractedText estimates its bytes plus a block per line and returns the gateway result', () => {
  it('writes text when the room is exactly its estimate', () => {
    boardAt({ ...F_WARNING, room: 64 + 1 });
    expect(setNodeExtractedText(PID, SID, 't1', 'a')).toEqual({ ok: true });
    expect(readTextBodies(PID, SID, ['t1']).get('t1')).toBe('a');
  });

  it('refuses it one byte short of that', () => {
    boardAt({ ...F_WARNING, room: 64 });
    expect(setNodeExtractedText(PID, SID, 't1', 'a')).toEqual({ ok: false, reason: 'no_room', room: 64 });
    expect(readTextBodies(PID, SID, ['t1']).get('t1')).toBe('hello');
  });

  it('counts every line as a block', () => {
    boardAt({ ...F_WARNING, room: 2 * 64 + 3 - 1 });
    expect(setNodeExtractedText(PID, SID, 't1', 'a\nb')).toEqual({ ok: false, reason: 'no_room', room: 2 * 64 + 2 });
  });

  it('counts a three-byte character as three bytes', () => {
    boardAt({ ...F_WARNING, room: 64 + 2 });
    expect(setNodeExtractedText(PID, SID, 't1', '中')).toEqual({ ok: false, reason: 'no_room', room: 66 });
  });

  it('covers what a body of many lines grows the document by', () => {
    const doc = boardAt(F_WARNING);
    const text = Array.from({ length: 10_000 }, (_, i) => `row ${i},a,b`).join('\n');
    const before = Y.encodeStateAsUpdate(doc).byteLength;
    expect(setNodeExtractedText(PID, SID, 't1', text)).toEqual({ ok: true });
    expect(estimateTextBodyBytes(text)).toBeGreaterThanOrEqual(Y.encodeStateAsUpdate(doc).byteLength - before);
  });
});

