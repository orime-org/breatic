// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec P-03:
 * on a full canvas, any sequence of the canvas and storyboard write functions
 * (spec sections 3 and 5) writes only pure deletes, and over the ceiling only
 * whole-type removals; a refused call writes nothing. Shapes come from the
 * shared `updateShape`, the function collab admits updates with.
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));

import { type CanvasNodeFields, type DocSizeStatus, type NodeMediaFields } from '@breatic/shared';
import { updateShape } from '@breatic/shared/update-shape';
import { P_FULL, P_OVER } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import {
  addEdge, addNode, addNodeFocusImage, addReply, appendNodeSlotItem, createGroup, editAnnotationBody, editReply,
  expandGroup, removeEdge, removeElements, removeNode, removeNodeFocusImage, removeNodeSlotItem, removeReply,
  resizeGroup, restoreNodeMedia, runCanvasUndoBatch, setGroupBackground, setNodeExtractedText, setNodeLocked,
  setNodeMode, setNodeModel, setNodeName, setNodeParams, setNodeParent, setNodePosition, setNodeSlotValue,
  setNodeTemplateNode, writeSnapshotNodes, _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import {
  addStoryboardShot, enterStoryboardShots, readShots, removeStoryboardShot, retotalStoryboard, setStoryboardShots,
  stepStoryboardShot,
} from '@web/data/yjs/node-storyboard';
import { clearAllDocSizes, setDocSize } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const P = 'p1';
const S = 's1';
const SRC = 'src';
const NAME = docName.canvasSpace(P, S);

/**
 * A node's wire fields.
 * @param id - Node id.
 * @param type - Modality.
 * @param data - Extra data fields.
 * @param parentId - Group link.
 * @returns The fields.
 * @throws {never} Never.
 */
function node(id: string, type: CanvasNodeFields['type'], data: Record<string, unknown> = {}, parentId?: string): CanvasNodeFields {
  return {
    id,
    type,
    position: { x: 10, y: 10 },
    ...(parentId === undefined ? {} : { parentId }),
    data: { name: id, createdAt: 1, createdBy: 'u', locked: false, ...data } as CanvasNodeFields['data'],
  };
}

/**
 * Builds spec section 3's `C0` (plus section 5's video `v1`) in a source
 * Space with the production writers, then loads it into the Space under test
 * as a remote update.
 * @throws {AssertionError} When a seed write is refused.
 */
function loadC0(): void {
  const seeds: CanvasNodeFields[] = [
    node('img1', 'image', {
      content: 'https://example.com/a.png', name: 'A', styleImages: ['u1', 'u2'], one: ['x'], k0: 'v0',
      focusImages: [{ id: 'f1', url: 'https://example.com/f1.png', name: 'A', width: 1, height: 1 }, { id: 'f2', url: 'https://example.com/f2.png', name: 'A', width: 1, height: 1 }],
    }),
    node('txt1', 'text', { content: 'hello' }),
    node('ann1', 'annotation', { content: 'note' }),
    node('g1', 'group', { backgroundColor: 'blue', width: 400, height: 300 }),
    node('m1', 'image', {}, 'g1'),
    node('m2', 'image', {}, 'g1'),
    node('g2', 'group', { width: 200, height: 200 }),
    node('g3', 'group', { width: 200, height: 200 }),
    node('m3', 'image', {}, 'g3'),
    node('lk1', 'image', { locked: true }),
    node('v1', 'video'),
  ];
  for (const seed of seeds) expect(addNode(P, SRC, seed)).toEqual({ ok: true });
  expect(addEdge(P, SRC, { id: 'e1', source: 'img1', target: 'txt1' })).toBe(true);
  expect(addReply(P, SRC, 'ann1', { id: 'r1', content: 'one', createdBy: 'u', createdAt: 1 })).toBe(true);
  expect(addReply(P, SRC, 'ann1', { id: 'r2', content: 'two', createdBy: 'u', createdAt: 2 })).toBe(true);
  setStoryboardShots(P, SRC, 'v1', [3, 3, 4]);
  expect(readShots(P, SRC, 'v1')?.length).toBe(3);
  Y.applyUpdate(getDoc(NAME), Y.encodeStateAsUpdate(getDoc(docName.canvasSpace(P, SRC))), 'remote');
}

/**
 * The id of one of `v1`'s shots now.
 * @param index - Shot index.
 * @returns Its id, or a missing one.
 * @throws {never} Never.
 */
function shotId(index: number): string {
  return readShots(P, S, 'v1')?.[index]?.id ?? 'missing-shot';
}

let fresh = 0;

/** Every write function of spec sections 3 and 5, with arguments drawn from `C0`. */
const CALLS: ReadonlyArray<readonly [string, () => void]> = [
  ['addNode', () => { fresh += 1; addNode(P, S, node(`new${fresh}`, 'image')); }],
  ['writeSnapshotNodes in an add batch', () => {
    fresh += 1;
    runCanvasUndoBatch(P, S, { kind: 'add' }, () => writeSnapshotNodes(getDoc(NAME), [{ id: `snap${fresh}`, type: 'image', position: { x: 0, y: 0 }, data: { name: 'S' } }], []));
  }],
  ['createGroup', () => { fresh += 1; createGroup(P, S, node(`grp${fresh}`, 'group'), [{ id: 'img1', position: { x: 1, y: 1 } }]); }],
  ['addEdge', () => { fresh += 1; addEdge(P, S, { id: `edge${fresh}`, source: 'txt1', target: 'img1' }); }],
  ['addReply', () => { fresh += 1; addReply(P, S, 'ann1', { id: `reply${fresh}`, content: 'new', createdBy: 'u', createdAt: 3 }); }],
  ['appendNodeSlotItem', () => { appendNodeSlotItem(P, S, 'img1', 'styleImages', 'u3', 4); }],
  ['addNodeFocusImage', () => { addNodeFocusImage(P, S, 'img1', { id: 'f3', url: 'https://example.com/f3.png', name: 'A', width: 1, height: 1 }); }],
  ['setNodeExtractedText', () => { setNodeExtractedText(P, S, 'txt1', 'line1\nline2'); }],
  ['restoreNodeMedia', () => { restoreNodeMedia(P, S, 'img1', { content: 'https://example.com/b.png', media: {} as NodeMediaFields }); }],
  ['editAnnotationBody', () => { editAnnotationBody(P, S, 'ann1', 'new body', 5); }],
  ['editReply', () => { editReply(P, S, 'ann1', 'r1', 'new', 5); }],
  ['setNodeName', () => { setNodeName(P, S, 'img1', 'B'); }],
  ['setNodeTemplateNode', () => { setNodeTemplateNode(P, S, 'img1', { template: 't', key: 'k' }); }],
  ['setNodeParams', () => { setNodeParams(P, S, 'img1', { m: { a: 1 } }); }],
  ['setNodeSlotValue', () => { setNodeSlotValue(P, S, 'img1', 'k', 'v'); }],
  ['setNodeModel', () => { setNodeModel(P, S, 'img1', 'mode', 'model-2', {}); }],
  ['setNodeMode', () => { setNodeMode(P, S, 'img1', 'mode-2', 'model-2', {}); }],
  ['setGroupBackground red', () => { setGroupBackground(P, S, 'g1', 'red'); }],
  ['setNodePosition', () => { setNodePosition(P, S, 'img1', { x: 9, y: 9 }, null); }],
  ['resizeGroup', () => { resizeGroup(P, S, 'g1', { x: 0, y: 0 }, 500, 500); }],
  ['expandGroup', () => { expandGroup(P, S, 'g1', { x: 0, y: 0 }, 600, 600); }],
  ['setNodeParent', () => { setNodeParent(P, S, 'img1', 'g2', { x: 1, y: 1 }); }],
  ['setNodeLocked true', () => { setNodeLocked(P, S, 'img1', true); }],
  ['setNodeLocked false', () => { setNodeLocked(P, S, 'lk1', false); }],
  ['setNodeSlotValue null', () => { setNodeSlotValue(P, S, 'img1', 'k0', null); }],
  ['setGroupBackground undefined', () => { setGroupBackground(P, S, 'g1', undefined); }],
  ['removeNodeSlotItem last', () => { removeNodeSlotItem(P, S, 'img1', 'one', 'x'); }],
  ['removeNodeSlotItem one of two', () => { removeNodeSlotItem(P, S, 'img1', 'styleImages', 'u1'); }],
  ['removeNodeFocusImage', () => { removeNodeFocusImage(P, S, 'img1', 'f1'); }],
  ['removeNode img1', () => { removeNode(P, S, 'img1'); }],
  ['removeNode g1', () => { removeNode(P, S, 'g1'); }],
  ['removeNode g2', () => { removeNode(P, S, 'g2'); }],
  ['removeEdge', () => { removeEdge(P, S, 'e1'); }],
  ['removeReply', () => { removeReply(P, S, 'ann1', 'r1'); }],
  ['removeElements group with members', () => { removeElements(P, S, ['g1', 'm1', 'm2'], []); }],
  ['removeElements group alone', () => { removeElements(P, S, ['g3'], []); }],
  ['removeElements group and one member', () => { removeElements(P, S, ['g1', 'm1'], []); }],
  ['addStoryboardShot', () => { addStoryboardShot(P, S, 'v1', 10, 6); }],
  ['setStoryboardShots', () => { setStoryboardShots(P, S, 'v1', [5, 5]); }],
  ['enterStoryboardShots', () => { enterStoryboardShots(P, S, 'v1', 12); }],
  ['retotalStoryboard', () => { retotalStoryboard(P, S, 'v1', 12); }],
  ['stepStoryboardShot', () => { stepStoryboardShot(P, S, 'v1', shotId(0), 1); }],
  ['removeStoryboardShot', () => { removeStoryboardShot(P, S, 'v1', shotId(1), 10); }],
];

/** What one call left behind. */
interface Outcome {
  label: string;
  toasted: boolean;
  shape: ReturnType<typeof updateShape> | null;
}

/**
 * Runs one call and reads the shape of the local updates it wrote.
 * @param label - The call's name.
 * @param call - The call.
 * @returns Whether it toasted and the shape, null when it wrote nothing.
 * @throws {Error} Whatever the call throws.
 */
function runCall(label: string, call: () => void): Outcome {
  const doc = getDoc(NAME);
  const mirror = new Y.Doc({ gc: false });
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
  const updates: Uint8Array[] = [];
  /**
   * Collects this client's updates.
   * @param update - The update.
   * @param _origin - Its origin.
   * @param _doc - The document.
   * @param transaction - The transaction.
   */
  const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void => {
    if (transaction.local) updates.push(update);
  };
  const toastsBefore = toast.warning.mock.calls.length;
  doc.on('update', onUpdate);
  try {
    call();
  } finally {
    doc.off('update', onUpdate);
  }
  const shape = updates.length === 0 ? null : updateShape(Y.mergeUpdates(updates), mirror.store);
  mirror.destroy();
  return { label, toasted: toast.warning.mock.calls.length > toastsBefore, shape };
}

/**
 * Resets the documents, the undo caches and the size states.
 * @throws {never} Never.
 */
function reset(): void {
  clearAllDocSizes();
  _resetCanvasUndoCacheForTests();
  _resetForTests();
}

beforeEach(() => {
  changeLocale('en');
  vi.clearAllMocks();
});

afterEach(reset);

describe('canvas writes on a full canvas (P-03)', () => {
  it('P-03 a refused call writes nothing; a written one is a pure delete when full and a whole-type removal over the ceiling', () => {
    const callArb = fc.constantFrom(...CALLS);
    fc.assert(fc.property(fc.constantFrom('F', 'O'), fc.array(callArb, { minLength: 1, maxLength: 8 }), (state, calls) => {
      reset();
      loadC0();
      setDocSize(NAME, { type: 'doc:size', ...(state === 'F' ? P_FULL : P_OVER) } as DocSizeStatus);
      for (const [label, call] of calls) {
        const outcome = runCall(label, call);
        if (outcome.toasted) expect(outcome, `${label} toasted and wrote`).toMatchObject({ shape: null });
        if (outcome.shape === null) continue;
        expect(outcome.shape.pureDelete, `${label} at ${state} wrote structs`).toBe(true);
        if (state === 'O') expect(outcome.shape.wholeTypesOnly, `${label} at O deleted part of a type`).toBe(true);
      }
    }), { numRuns: 40 });
  });
});
