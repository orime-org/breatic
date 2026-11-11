// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap v2 (inner#1790 v2 web test spec, sections 3 and 4
 * B-01 to B-03): every canvas write function is classified into one kind,
 * checked both ways against the shape of the update it sends (shared
 * `updateShape`), and gated by the pushed state through the row template
 * `T(kind)` of spec 0.6.
 *
 * The initial content `C0` is built in a separate document and loaded as a
 * peer's update, so only the write under test is this client's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';
import { bodyFromText, bodyToPlainText } from '@breatic/shared/canvas/text-body';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
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
  getCanvasUndoManager,
  isNodeLocked,
  removeEdge,
  removeElements,
  removeNode,
  removeNodeFocusImage,
  removeNodeSlotItem,
  removeReply,
  resizeGroup,
  restoreNodeMedia,
  runCanvasUndoBatch,
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
  writeSnapshotNodes,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import {
  captureWrite,
  enterSize,
  expectKindShape,
  expectSizeToast,
  kindRows,
  loadRemote,
  SIZE_COPY_EN,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p1';
const SID = 's1';
const NAME = docName.canvasSpace(PID, SID);
const URL_A = 'https://cdn.example.test/a.png';
const URL_B = 'https://cdn.example.test/b.png';

/**
 * A focus crop entry.
 * @param id - Its id.
 * @returns The entry.
 */
function focus(id: string): { id: string; url: string; name: string; width: number; height: number } {
  return { id, url: `https://cdn.example.test/${id}.png`, name: 'A', width: 64, height: 64 };
}

/**
 * Writes one node in the wire layout (node map with a nested data map).
 * @param source - The source document.
 * @param id - Node id.
 * @param type - Node type.
 * @param data - Data fields; Y types are placed as they are.
 * @param at - Position and Group link.
 * @param at.position - Position.
 * @param at.parentId - Group the position is measured against.
 */
function putNode(
  source: Y.Doc,
  id: string,
  type: string,
  data: Record<string, unknown>,
  at: { position?: { x: number; y: number }; parentId?: string } = {},
): void {
  const node = new Y.Map<unknown>();
  const map = new Y.Map<unknown>();
  node.set('id', id);
  node.set('type', type);
  if (at.parentId !== undefined) node.set('parentId', at.parentId);
  node.set('position', at.position ?? { x: 0, y: 0 });
  for (const [key, value] of Object.entries({ name: id, createdAt: 1, createdBy: 'u1', ...data })) map.set(key, value);
  node.set('data', map);
  source.getMap<Y.Map<unknown>>('nodesMap').set(id, node);
}

/**
 * Builds `C0` of spec section 3 (plus `tb`, a text node without a body,
 * `lkf` with `locked: false` stored, and `img2` with focus crops in the old
 * plain-array form).
 * @param source - The source document.
 */
function buildC0(source: Y.Doc): void {
  source.transact(() => {
    const crops = new Y.Array<unknown>();
    crops.push([focus('f1'), focus('f2')]);
    putNode(source, 'img1', 'image', { name: 'A', content: URL_A, styleImages: ['u1', 'u2'], focusImages: crops, one: ['x'], k: 'old' });
    putNode(source, 'img2', 'image', { content: URL_B, focusImages: [focus('f1'), focus('f2')] });
    putNode(source, 'txt1', 'text', { body: bodyFromText('hello') });
    putNode(source, 'tb', 'text', {});
    const replies = new Y.Array<Y.Map<unknown>>();
    for (const id of ['r1', 'r2']) {
      const reply = new Y.Map<unknown>();
      reply.set('id', id);
      reply.set('content', `reply ${id}`);
      reply.set('createdBy', 'u1');
      reply.set('createdAt', 2);
      replies.push([reply]);
    }
    putNode(source, 'ann1', 'annotation', { content: 'note', replies });
    putNode(source, 'g1', 'group', { width: 400, height: 300, backgroundColor: 'blue' }, { position: { x: 100, y: 100 } });
    putNode(source, 'm1', 'image', { content: URL_A }, { position: { x: 10, y: 10 }, parentId: 'g1' });
    putNode(source, 'm2', 'image', { content: URL_A }, { position: { x: 20, y: 20 }, parentId: 'g1' });
    putNode(source, 'g2', 'group', { width: 200, height: 200 }, { position: { x: 600, y: 0 } });
    putNode(source, 'g3', 'group', { width: 200, height: 200 }, { position: { x: 900, y: 0 } });
    putNode(source, 'm3', 'image', { content: URL_A }, { position: { x: 5, y: 5 }, parentId: 'g3' });
    putNode(source, 'lk1', 'image', { content: URL_A, locked: true });
    putNode(source, 'lkf', 'image', { content: URL_A, locked: false });
    const edge = new Y.Map<unknown>();
    edge.set('id', 'e1');
    edge.set('source', 'img1');
    edge.set('target', 'txt1');
    edge.set('createdAt', 3);
    source.getMap<Y.Map<unknown>>('edgesMap').set('e1', edge);
  });
}

/**
 * A fresh registered canvas document holding `C0`, loaded as a peer's update.
 * @returns The document.
 */
function seed(): Y.Doc {
  const doc = getDoc(NAME);
  loadRemote(doc, buildC0);
  return doc;
}

/**
 * A node's map.
 * @param doc - Canvas document.
 * @param id - Node id.
 * @returns The node, or undefined.
 */
function nodeOf(doc: Y.Doc, id: string): Y.Map<unknown> | undefined {
  return doc.getMap<Y.Map<unknown>>('nodesMap').get(id);
}

/**
 * A node's data map.
 * @param doc - Canvas document.
 * @param id - Node id.
 * @returns The data map.
 * @throws {Error} When the node is missing.
 */
function dataOf(doc: Y.Doc, id: string): Y.Map<unknown> {
  const data = nodeOf(doc, id)?.get('data');
  if (!(data instanceof Y.Map)) throw new Error(`node ${id} has no data map`);
  return data;
}

/**
 * The refusal a state gives (spec 2.1).
 * @param code - The state.
 * @returns The refusal result.
 */
function refusalOf(code: SizeCode): { ok: false; reason: 'full' | 'over_ceiling' | 'resyncing' } {
  if (code === 'Z') return { ok: false, reason: 'resyncing' };
  return { ok: false, reason: code === 'O' || code === 'CEIL' ? 'over_ceiling' : 'full' };
}

/**
 * A new image node.
 * @param id - Its id.
 * @returns The wire fields.
 */
function imageNode(id: string): CanvasNodeFields {
  return { id, type: 'image', position: { x: 40, y: 40 }, data: { name: id, createdAt: 9, createdBy: 'u1', locked: false, attachments: [], content: URL_B } } as CanvasNodeFields;
}

const ROW = { name: NAME, seed };

beforeEach(() => {
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  clearAllDocSizes();
  vi.clearAllMocks();
});

describe('section 3: add writes', () => {
  describe('E-01', () => {
    kindRows({
      ...ROW,
      id: 'E-01',
      title: 'addNode of a new image node',
      kind: 'add',
      run: () => addNode(PID, SID, imageNode('n9')),
      written: (result, doc) => {
        expect(result).toEqual({ ok: true });
        expect(nodeOf(doc, 'n9')).toBeInstanceOf(Y.Map);
      },
      refused: (result, doc, code) => {
        expect(result).toEqual(refusalOf(code));
        expect(doc.getMap('nodesMap').has('n9')).toBe(false);
      },
    });
  });

  describe('E-02', () => {
    const fn = vi.fn((): void => {
      writeSnapshotNodes(getDoc(NAME), [
        { id: 'n7', type: 'image', position: { x: 0, y: 0 }, data: { name: 'n7', content: URL_A } },
        { id: 'n8', type: 'image', position: { x: 300, y: 0 }, data: { name: 'n8', content: URL_B } },
      ], [{ id: 'n7->n8', source: 'n7', target: 'n8', createdAt: 4 }]);
    });
    let depth = 0;
    kindRows({
      ...ROW,
      id: 'E-02',
      title: 'runCanvasUndoBatch(add) around writeSnapshotNodes of two nodes and one edge',
      kind: 'add',
      seed: () => {
        fn.mockClear();
        const doc = seed();
        depth = getCanvasUndoManager(doc, NAME).undoStack.length;
        return doc;
      },
      run: () => runCanvasUndoBatch(PID, SID, { kind: 'add' }, fn),
      written: (result, doc) => {
        expect(result).toEqual({ ok: true });
        expect(fn).toHaveBeenCalledTimes(1);
        expect(getCanvasUndoManager(doc, NAME).undoStack.length).toBe(depth + 1);
      },
      refused: (result, doc, code) => {
        expect(result).toEqual(refusalOf(code));
        expect(fn).not.toHaveBeenCalled();
        expect(getCanvasUndoManager(doc, NAME).undoStack.length).toBe(depth);
      },
    });

    it('E-02 writeSnapshotNodes into a throwaway document is not judged (unchanged in v2)', () => {
      enterSize(NAME, 'F');
      const tmp = new Y.Doc();
      writeSnapshotNodes(tmp, [{ id: 'n9', type: 'image', position: { x: 0, y: 0 }, data: {} }], []);
      expect(tmp.getMap('nodesMap').has('n9')).toBe(true);
      expectSizeToast(null);
      tmp.destroy();
    });
  });

  describe('E-03', () => {
    kindRows({
      ...ROW,
      id: 'E-03',
      title: 'createGroup taking img1 in',
      kind: 'add',
      run: () => createGroup(PID, SID, {
        id: 'g9', type: 'group', position: { x: -10, y: -10 },
        data: { name: 'G', createdAt: 9, createdBy: 'u1', width: 300, height: 300 },
      } as CanvasNodeFields, [{ id: 'img1', position: { x: 10, y: 10 } }]),
      written: (_result, doc) => expect(nodeOf(doc, 'img1')?.get('parentId')).toBe('g9'),
      refused: (_result, doc) => {
        expect(nodeOf(doc, 'img1')?.has('parentId')).toBe(false);
        expect(doc.getMap('nodesMap').has('g9')).toBe(false);
      },
    });
  });

  describe('E-04', () => {
    kindRows({
      ...ROW,
      id: 'E-04',
      title: 'addEdge txt1->img1',
      kind: 'add',
      run: () => addEdge(PID, SID, { id: 'txt1->img1', source: 'txt1', target: 'img1' }),
      written: (result) => expect(result).toBe(true),
      refused: (result, doc) => {
        expect(result).toBe(false);
        expect(doc.getMap('edgesMap').has('txt1->img1')).toBe(false);
      },
    });
    kindRows({
      ...ROW,
      id: 'E-04',
      title: 'addReply to ann1',
      kind: 'add',
      run: () => addReply(PID, SID, 'ann1', { id: 'r3', content: 'third', createdBy: 'u1', createdAt: 5 }),
      written: (result) => expect(result).toBe(true),
      refused: (result, doc) => {
        expect(result).toBe(false);
        expect((dataOf(doc, 'ann1').get('replies') as Y.Array<unknown>).length).toBe(2);
      },
    });
  });

  describe('E-05', () => {
    kindRows({
      ...ROW,
      id: 'E-05',
      title: 'appendNodeSlotItem styleImages u3',
      kind: 'add',
      run: () => appendNodeSlotItem(PID, SID, 'img1', 'styleImages', 'u3', 4),
      written: (result, doc) => {
        expect(result).toBe('added');
        expect(dataOf(doc, 'img1').get('styleImages')).toEqual(['u1', 'u2', 'u3']);
      },
      refused: (result, doc) => {
        expect(result).toBe('refused');
        expect(dataOf(doc, 'img1').get('styleImages')).toEqual(['u1', 'u2']);
      },
    });
  });

  describe('E-06', () => {
    kindRows({
      ...ROW,
      id: 'E-06',
      title: 'addNodeFocusImage f3',
      kind: 'add',
      run: () => addNodeFocusImage(PID, SID, 'img1', focus('f3')),
      written: (result) => expect(result).toBe('added'),
      refused: (result, doc) => {
        expect(result).toBe('refused');
        expect((dataOf(doc, 'img1').get('focusImages') as Y.Array<{ id: string }>).toArray().map((f) => f.id)).toEqual(['f1', 'f2']);
      },
    });
  });

  describe('E-07', () => {
    kindRows({
      ...ROW,
      id: 'E-07',
      title: 'ensureTextBody on a text node without a body',
      kind: 'add',
      run: () => ensureTextBody(PID, SID, 'tb'),
      written: (result) => expect(result).toBeInstanceOf(Y.XmlFragment),
      refused: (result, doc) => {
        expect(result).toBeNull();
        expect(dataOf(doc, 'tb').has('body')).toBe(false);
      },
    });
    kindRows({
      ...ROW,
      id: 'E-07',
      title: 'setNodeExtractedText into txt1',
      kind: 'add',
      run: () => setNodeExtractedText(PID, SID, 'txt1', 'line1\nline2'),
      written: (result, doc) => {
        expect(result).toEqual({ ok: true });
        expect(bodyToPlainText(dataOf(doc, 'txt1').get('body') as Y.XmlFragment)).toBe('line1\nline2');
      },
      refused: (result, doc, code) => {
        expect(result).toEqual(refusalOf(code));
        expect(bodyToPlainText(dataOf(doc, 'txt1').get('body') as Y.XmlFragment)).toBe('hello');
      },
    });
    kindRows({
      ...ROW,
      id: 'E-07',
      title: 'restoreNodeMedia on img1',
      kind: 'add',
      run: () => restoreNodeMedia(PID, SID, 'img1', {
        content: 'https://cdn.example.test/restored.png',
        media: { coverUrl: null, width: 640, height: 480, duration: null, mimeType: 'image/png', size: 1234 },
      }),
      written: (_result, doc) => expect(dataOf(doc, 'img1').get('content')).toBe('https://cdn.example.test/restored.png'),
      refused: (_result, doc) => expect(dataOf(doc, 'img1').get('content')).toBe(URL_A),
    });
  });

  describe('E-08', () => {
    kindRows({
      ...ROW,
      id: 'E-08',
      title: 'editAnnotationBody of ann1',
      kind: 'add',
      run: () => editAnnotationBody(PID, SID, 'ann1', 'new body', 7),
      written: (result) => expect(result).toBe(true),
      refused: (result, doc) => {
        expect(result).toBe(false);
        expect(dataOf(doc, 'ann1').get('content')).toBe('note');
      },
    });
    kindRows({
      ...ROW,
      id: 'E-08',
      title: 'editReply r1 of ann1',
      kind: 'add',
      run: () => editReply(PID, SID, 'ann1', 'r1', 'new', 7),
      written: (result) => expect(result).toBe(true),
      refused: (result, doc) => {
        expect(result).toBe(false);
        expect((dataOf(doc, 'ann1').get('replies') as Y.Array<Y.Map<unknown>>).get(0).get('content')).toBe('reply r1');
      },
    });
  });

  describe('E-09', () => {
    kindRows({
      ...ROW,
      id: 'E-09',
      title: 'addNode of a new text node with its words written into the body',
      kind: 'add',
      run: () => addNode(PID, SID, {
        id: 't9', type: 'text', position: { x: 0, y: 0 },
        data: { name: 't9', createdAt: 9, createdBy: 'u1', locked: false, attachments: [], content: 'written words' },
      } as CanvasNodeFields),
      written: (_result, doc) => expect(bodyToPlainText(dataOf(doc, 't9').get('body') as Y.XmlFragment)).toBe('written words'),
      refused: (_result, doc) => expect(doc.getMap('nodesMap').has('t9')).toBe(false),
    });
  });
});

describe('section 3: edit writes', () => {
  /** One edit row whose refusal leaves a value as it was. */
  const edits: ReadonlyArray<{ id: string; title: string; run: () => unknown; read: (doc: Y.Doc) => unknown; was: unknown }> = [
    { id: 'E-10', title: 'setNodeName img1 B', run: () => setNodeName(PID, SID, 'img1', 'B'), read: (d) => dataOf(d, 'img1').get('name'), was: 'A' },
    {
      id: 'E-10', title: 'setNodeTemplateNode img1',
      run: () => setNodeTemplateNode(PID, SID, 'img1', { template: 'tpl', key: 'hero' }),
      read: (d) => dataOf(d, 'img1').get('templateNode'), was: undefined,
    },
    { id: 'E-10', title: 'setNodeParams img1', run: () => setNodeParams(PID, SID, 'img1', { m1: { seed: 1 } }), read: (d) => dataOf(d, 'img1').get('paramsByModel'), was: undefined },
    { id: 'E-10', title: 'setNodeSlotValue img1 k v', run: () => setNodeSlotValue(PID, SID, 'img1', 'k', 'v'), read: (d) => dataOf(d, 'img1').get('k'), was: 'old' },
    { id: 'E-10', title: 'setNodeModel img1', run: () => setNodeModel(PID, SID, 'img1', 't2i', 'm2', {}), read: (d) => dataOf(d, 'img1').get('model'), was: undefined },
    { id: 'E-10', title: 'setNodeMode img1', run: () => setNodeMode(PID, SID, 'img1', 'i2i', 'm3', {}), read: (d) => dataOf(d, 'img1').get('mode'), was: undefined },
    { id: 'E-11', title: 'setGroupBackground g1 red', run: () => setGroupBackground(PID, SID, 'g1', 'red'), read: (d) => dataOf(d, 'g1').get('backgroundColor'), was: 'blue' },
    { id: 'E-11', title: 'setNodePosition img1', run: () => setNodePosition(PID, SID, 'img1', { x: 9, y: 9 }, null), read: (d) => nodeOf(d, 'img1')?.get('position'), was: { x: 0, y: 0 } },
    {
      id: 'E-11', title: 'resizeGroup g1', run: () => resizeGroup(PID, SID, 'g1', { x: 100, y: 100 }, 500, 400),
      read: (d) => [dataOf(d, 'g1').get('width'), dataOf(d, 'g1').get('height')], was: [400, 300],
    },
    {
      id: 'E-11', title: 'expandGroup g1', run: () => expandGroup(PID, SID, 'g1', { x: 90, y: 90 }, 500, 400),
      read: (d) => [nodeOf(d, 'g1')?.get('position'), nodeOf(d, 'm1')?.get('position')], was: [{ x: 100, y: 100 }, { x: 10, y: 10 }],
    },
    {
      id: 'E-11', title: 'setNodeParent img1 into g2', run: () => setNodeParent(PID, SID, 'img1', 'g2', { x: 1, y: 1 }),
      read: (d) => [nodeOf(d, 'img1')?.get('parentId'), nodeOf(d, 'img1')?.get('position')], was: [undefined, { x: 0, y: 0 }],
    },
    { id: 'E-11', title: 'setNodeLocked img1 true', run: () => setNodeLocked(PID, SID, 'img1', true), read: (d) => dataOf(d, 'img1').get('locked'), was: undefined },
  ];
  for (const edit of edits) {
    describe(edit.id, () => {
      kindRows({
        ...ROW,
        id: edit.id,
        title: edit.title,
        kind: 'edit',
        run: edit.run,
        written: (_result, doc) => expect(edit.read(doc)).not.toEqual(edit.was),
        refused: (_result, doc) => expect(edit.read(doc)).toEqual(edit.was),
      });
    });
  }

  it('E-10 a refused rename at F says the add sentence, not the v1 overwrite notice', () => {
    const doc = seed();
    enterSize(NAME, 'F');
    vi.mocked(toast.warning).mockClear();
    setNodeName(PID, SID, 'img1', 'B');
    expect(dataOf(doc, 'img1').get('name')).toBe('A');
    expect(vi.mocked(toast.warning).mock.calls).toEqual([[SIZE_COPY_EN.T_ADD]]);
  });
});

describe('section 3: remove and delete writes', () => {
  describe('E-12', () => {
    kindRows({
      ...ROW,
      id: 'E-12',
      title: 'setNodeLocked lk1 false (unlock)',
      kind: 'remove',
      codes: ['U', 'F', 'O', 'CEIL', 'Z'],
      run: () => setNodeLocked(PID, SID, 'lk1', false),
      written: (_result, doc) => {
        expect(dataOf(doc, 'lk1').has('locked')).toBe(false);
        expect(isNodeLocked(PID, SID, 'lk1')).toBe(false);
      },
      refused: (_result, doc) => expect(isNodeLocked(PID, SID, 'lk1') && dataOf(doc, 'lk1').get('locked') === true).toBe(true),
    });
  });

  describe('E-13', () => {
    kindRows({
      ...ROW,
      id: 'E-13',
      title: 'setNodeLocked false on a node that stores locked: false',
      kind: 'remove',
      codes: ['U', 'O'],
      run: () => setNodeLocked(PID, SID, 'lkf', false),
      written: (_result, doc) => expect(dataOf(doc, 'lkf').has('locked')).toBe(false),
    });
  });

  describe('E-14', () => {
    kindRows({
      ...ROW,
      id: 'E-14',
      title: 'setNodeSlotValue img1 k null',
      kind: 'remove',
      run: () => setNodeSlotValue(PID, SID, 'img1', 'k', null),
      written: (_result, doc) => expect(dataOf(doc, 'img1').has('k')).toBe(false),
      refused: (_result, doc) => expect(dataOf(doc, 'img1').get('k')).toBe('old'),
    });
    kindRows({
      ...ROW,
      id: 'E-14',
      title: 'setGroupBackground g1 undefined',
      kind: 'remove',
      run: () => setGroupBackground(PID, SID, 'g1', undefined),
      written: (_result, doc) => expect(dataOf(doc, 'g1').has('backgroundColor')).toBe(false),
      refused: (_result, doc) => expect(dataOf(doc, 'g1').get('backgroundColor')).toBe('blue'),
    });
    kindRows({
      ...ROW,
      id: 'E-14',
      title: 'removeNodeSlotItem of the last item of one',
      kind: 'remove',
      run: () => removeNodeSlotItem(PID, SID, 'img1', 'one', 'x'),
      written: (_result, doc) => expect(dataOf(doc, 'img1').has('one')).toBe(false),
      refused: (_result, doc) => expect(dataOf(doc, 'img1').get('one')).toEqual(['x']),
    });
  });

  describe('E-15', () => {
    kindRows({
      ...ROW,
      id: 'E-15',
      title: 'removeNodeFocusImage f1 from the Y.Array',
      kind: 'delete',
      run: () => removeNodeFocusImage(PID, SID, 'img1', 'f1'),
      written: (result, doc) => {
        expect(result).toBe(true);
        expect((dataOf(doc, 'img1').get('focusImages') as Y.Array<{ id: string }>).toArray().map((f) => f.id)).toEqual(['f2']);
      },
      refused: (result, doc) => {
        expect(result).toBe(false);
        expect((dataOf(doc, 'img1').get('focusImages') as Y.Array<{ id: string }>).toArray().map((f) => f.id)).toEqual(['f1', 'f2']);
      },
    });
  });

  describe('E-16', () => {
    const removes: ReadonlyArray<{ title: string; run: () => unknown; gone: (doc: Y.Doc) => boolean }> = [
      { title: 'removeNode img1', run: () => removeNode(PID, SID, 'img1'), gone: (d) => !d.getMap('nodesMap').has('img1') },
      { title: 'removeEdge e1', run: () => removeEdge(PID, SID, 'e1'), gone: (d) => !d.getMap('edgesMap').has('e1') },
      {
        title: 'removeReply r1 of ann1', run: () => removeReply(PID, SID, 'ann1', 'r1'),
        gone: (d) => (dataOf(d, 'ann1').get('replies') as Y.Array<Y.Map<unknown>>).toArray().every((r) => r.get('id') !== 'r1'),
      },
      { title: 'removeNode g2 (an empty Group)', run: () => removeNode(PID, SID, 'g2'), gone: (d) => !d.getMap('nodesMap').has('g2') },
    ];
    for (const write of removes) {
      kindRows({
        ...ROW,
        id: 'E-16',
        title: write.title,
        kind: 'remove',
        codes: ['U', 'F', 'O', 'CEIL', 'Z'],
        run: write.run,
        written: (_result, doc) => expect(write.gone(doc)).toBe(true),
        refused: (_result, doc) => expect(write.gone(doc)).toBe(false),
      });
    }
  });

  describe('E-17', () => {
    kindRows({
      ...ROW,
      id: 'E-17',
      title: 'removeElements of g1 with all its members',
      kind: 'remove',
      run: () => removeElements(PID, SID, ['g1', 'm1', 'm2'], []),
      written: (result, doc) => {
        expect(result).toEqual({ ok: true });
        for (const id of ['g1', 'm1', 'm2']) expect(doc.getMap('nodesMap').has(id)).toBe(false);
      },
    });

    it('E-17 the release of the members is skipped: the update rewrites no member position or parentId', () => {
      const doc = seed();
      enterSize(NAME, 'O');
      const captured = captureWrite(doc, () => removeElements(PID, SID, ['g1', 'm1', 'm2'], []));
      expectKindShape('remove', captured);
      expect(Y.decodeUpdate(captured.update!).structs).toEqual([]);
    });
  });

  describe('E-18', () => {
    const compounds: ReadonlyArray<{ title: string; run: () => unknown; group: string; members: string[]; outside: string }> = [
      { title: 'removeNode g1 with members outside the delete', run: () => removeNode(PID, SID, 'g1'), group: 'g1', members: ['m1', 'm2'], outside: 'm2' },
      { title: 'removeElements of g3 alone', run: () => removeElements(PID, SID, ['g3'], []), group: 'g3', members: ['m3'], outside: 'm3' },
      { title: 'removeElements of g1 and m1 with m2 outside', run: () => removeElements(PID, SID, ['g1', 'm1'], []), group: 'g1', members: ['m1', 'm2'], outside: 'm2' },
    ];
    for (const write of compounds) {
      kindRows({
        ...ROW,
        id: 'E-18',
        title: write.title,
        kind: 'compound',
        run: write.run,
        written: (_result, doc) => {
          const member = nodeOf(doc, write.outside)!;
          expect(member.has('parentId')).toBe(false);
          const group = write.group === 'g1' ? { x: 100, y: 100 } : { x: 900, y: 0 };
          const local = write.outside === 'm2' ? { x: 20, y: 20 } : { x: 5, y: 5 };
          expect(member.get('position')).toEqual({ x: local.x + group.x, y: local.y + group.y });
        },
        refused: (_result, doc) => {
          expect(nodeOf(doc, write.group)).toBeInstanceOf(Y.Map);
          for (const id of write.members) expect(nodeOf(doc, id)?.get('parentId')).toBe(write.group);
        },
      });
    }
  });

  describe('E-19', () => {
    kindRows({
      ...ROW,
      id: 'E-19',
      title: 'removeNodeSlotItem u1 leaving u2',
      kind: 'compound',
      run: () => removeNodeSlotItem(PID, SID, 'img1', 'styleImages', 'u1'),
      written: (_result, doc) => expect(dataOf(doc, 'img1').get('styleImages')).toEqual(['u2']),
      refused: (_result, doc) => expect(dataOf(doc, 'img1').get('styleImages')).toEqual(['u1', 'u2']),
    });
  });

  describe('E-20', () => {
    kindRows({
      ...ROW,
      id: 'E-20',
      title: 'removeNodeFocusImage on the old plain-array form',
      kind: 'compound',
      run: () => removeNodeFocusImage(PID, SID, 'img2', 'f1'),
      written: (result) => expect(result).toBe(true),
      refused: (_result, doc) => {
        const crops = dataOf(doc, 'img2').get('focusImages');
        expect(Array.isArray(crops)).toBe(true);
        expect(crops).toEqual([focus('f1'), focus('f2')]);
      },
    });
  });

  describe('E-21 removeNode and removeElements return the writeSpaceDoc result', () => {
    it.each([
      ['U', 'removeNode g1', (): unknown => removeNode(PID, SID, 'g1'), { ok: true }],
      ['U', 'removeElements g1, m1, m2', (): unknown => removeElements(PID, SID, ['g1', 'm1', 'm2'], []), { ok: true }],
      ['F', 'removeNode g1', (): unknown => removeNode(PID, SID, 'g1'), { ok: false, reason: 'full' }],
      ['F', 'removeElements g1, m1', (): unknown => removeElements(PID, SID, ['g1', 'm1'], []), { ok: false, reason: 'full' }],
      ['Z', 'removeNode img1', (): unknown => removeNode(PID, SID, 'img1'), { ok: false, reason: 'resyncing' }],
      ['Z', 'removeElements img1', (): unknown => removeElements(PID, SID, ['img1'], []), { ok: false, reason: 'resyncing' }],
    ] as const)('E-21 [%s] %s', (code, _title, call, expected) => {
      seed();
      enterSize(NAME, code);
      expect(call()).toEqual(expected);
    });
  });
});

describe('section 4: runCanvasUndoBatch is judged once, as a whole', () => {
  it('B-01 an add batch at F runs nothing, leaves the undo stack and says T_ADD', () => {
    const doc = seed();
    const undo = getCanvasUndoManager(doc, NAME);
    const depth = undo.undoStack.length;
    enterSize(NAME, 'F');
    vi.mocked(toast.warning).mockClear();
    const fn = vi.fn((): void => {
      addNode(PID, SID, imageNode('n9'));
    });
    const captured = captureWrite(doc, () => runCanvasUndoBatch(PID, SID, { kind: 'add' }, fn));
    expect(captured.result).toEqual({ ok: false, reason: 'full' });
    expect(fn).not.toHaveBeenCalled();
    expect(captured.shape).toBe('∅');
    expect(undo.undoStack.length).toBe(depth);
    expectSizeToast(SIZE_COPY_EN.T_ADD);
  });

  it('B-02 a remove batch at O runs, its inner writes are not judged again, one undo step, shape R', () => {
    const doc = seed();
    const undo = getCanvasUndoManager(doc, NAME);
    const depth = undo.undoStack.length;
    enterSize(NAME, 'O');
    vi.mocked(toast.warning).mockClear();
    const fn = vi.fn((): void => {
      removeNode(PID, SID, 'img1');
      removeEdge(PID, SID, 'e1');
    });
    const captured = captureWrite(doc, () => runCanvasUndoBatch(PID, SID, { kind: 'remove' }, fn));
    expect(captured.result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(doc.getMap('nodesMap').has('img1')).toBe(false);
    expect(doc.getMap('edgesMap').has('e1')).toBe(false);
    expect(undo.undoStack.length).toBe(depth + 1);
    expectKindShape('remove', captured);
    expectSizeToast(null);
  });

  it('B-03 a compound batch at F is refused with T_COMPOUND', () => {
    const doc = seed();
    enterSize(NAME, 'F');
    vi.mocked(toast.warning).mockClear();
    const fn = vi.fn((): void => {
      removeNode(PID, SID, 'g1');
    });
    const captured = captureWrite(doc, () => runCanvasUndoBatch(PID, SID, { kind: 'compound' }, fn));
    expect(captured.result).toEqual({ ok: false, reason: 'full' });
    expect(fn).not.toHaveBeenCalled();
    expect(captured.shape).toBe('∅');
    expectSizeToast(SIZE_COPY_EN.T_COMPOUND);
  });
});
