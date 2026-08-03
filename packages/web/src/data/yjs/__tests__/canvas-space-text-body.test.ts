// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A text node's body in the canvas document (#1774, design sections 5 and 6).
 *
 * The body is a `Y.XmlFragment` under the node's own `data`, exactly where the
 * generation prompt lives. An earlier revision moved it to a top-level map to
 * dodge the canvas's deep observer; measurement killed that reason (design
 * section 7: a keystroke costs half a millisecond on a 500-node board and
 * re-renders zero nodes), so it came back to the node.
 *
 * Two of the four things the node subtree provides come free at this position
 * and are asserted here anyway, because "free" means "nothing in the code says
 * so" — a later change could take them away silently:
 *
 * - Undo scope. The node subtree is already in the undo manager's scope, so
 *   deleting a node and pressing undo brings the writing back.
 * - Lifecycle. The body is part of the node, so deleting the node takes it.
 *
 * The two that are NOT free (reactivity and copy) follow from the body leaving
 * the node-view projection rather than from where it is stored; they live in
 * the component and clipboard tests.
 *
 * Seeding is the one thing that must be explicit. A body created on demand is
 * a whole-container race: two clients opening the same node each make one, the
 * single map key keeps the last write, and the loser's writing disappears with
 * their container. So every text node is born with a body, and a node that
 * somehow has none is REPAIRED — under an origin the undo manager does not
 * track, or one press of undo deletes what the user just typed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  createCanvasUndoManager,
  readNodes,
  removeElements,
  removeNode,
  runCanvasUndoBatch,
  getTextBody,
  reseedTextBody,
} from '@web/data/yjs/canvas-space';
import { bodyToPlainText, writePlainTextIntoBody } from '@web/data/yjs/text-body';

const PID = 'p1';
const SID = 's1';

/**
 * Builds a complete wire `CanvasNodeFields` fixture.
 * @param type - The node modality.
 * @param opts - Optional id override.
 * @returns A complete node fields object.
 */
function sampleFields(type: NodeType, opts: { id?: string } = {}): CanvasNodeFields {
  return {
    id: opts.id ?? 'n1',
    type,
    position: { x: 10, y: 20 },
    data: {
      name: 'N',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
    },
  };
}

/**
 * The canvas document under test.
 * @returns The Y.Doc for the fixture project and space.
 */
function doc(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

/**
 * A node's `data` map, straight from the document.
 * @param nodeId - The node to look up.
 * @returns The data map, or undefined when the node is gone.
 */
function dataMap(nodeId: string): Y.Map<unknown> | undefined {
  const node = doc().getMap<Y.Map<unknown>>('nodesMap').get(nodeId);
  const data = node?.get('data');
  return data instanceof Y.Map ? data : undefined;
}

/**
 * Whether the node still carries a body.
 * @param nodeId - The node to look up.
 * @returns True when a body is present.
 */
function hasBody(nodeId: string): boolean {
  return dataMap(nodeId)?.get('body') instanceof Y.XmlFragment;
}

describe('text node bodies in the canvas document (#1774)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  describe('seeding at birth', () => {
    it('gives a new text node a body holding one empty block', () => {
      addNode(PID, SID, sampleFields('text'));
      const body = getTextBody(PID, SID, 'n1');
      expect(body).not.toBeNull();
      expect(body?.length).toBe(1);
      expect(bodyToPlainText(body as Y.XmlFragment)).toBe('');
    });

    it('puts it under the node, next to the generation prompt', () => {
      addNode(PID, SID, sampleFields('text'));
      expect(hasBody('n1')).toBe(true);
      // No new top-level table: the document holds nodes and edges, nothing else.
      expect(doc().getMap('textBodies').size).toBe(0);
    });

    it('leaves other modalities alone', () => {
      addNode(PID, SID, sampleFields('image', { id: 'img' }));
      expect(hasBody('img')).toBe(false);
      expect(getTextBody(PID, SID, 'img')).toBeNull();
    });
  });

  describe('the body stays out of the node view', () => {
    it('is not projected, so typing leaves every rendered field untouched', () => {
      addNode(PID, SID, sampleFields('text'));
      const body = getTextBody(PID, SID, 'n1') as Y.XmlFragment;
      writePlainTextIntoBody(body, 'first draft');

      const before = JSON.stringify(readNodes(doc()));
      for (let i = 0; i < 10; i += 1) {
        (body.get(0) as Y.XmlElement).insert(0, [new Y.XmlText('x')]);
      }

      // This is what makes a keystroke re-render zero nodes: the canvas mirror
      // compares views field by field, and none of them moved. Project the body
      // into the view and every node on the board gets a fresh object instead.
      expect(JSON.stringify(readNodes(doc()))).toBe(before);
      expect(bodyToPlainText(body)).toBe('xxxxxxxxxxfirst draft');
    });

    it('still reports real node changes, so the comparison above means something', () => {
      addNode(PID, SID, sampleFields('text'));
      const before = JSON.stringify(readNodes(doc()));
      dataMap('n1')?.set('name', 'renamed');
      expect(JSON.stringify(readNodes(doc()))).not.toBe(before);
    });
  });

  describe('deletion takes the body with it', () => {
    it('through removeNode', () => {
      addNode(PID, SID, sampleFields('text'));
      removeNode(PID, SID, 'n1');
      expect(getTextBody(PID, SID, 'n1')).toBeNull();
    });

    it('through removeElements, which is where the Delete key goes', () => {
      addNode(PID, SID, sampleFields('text'));
      removeElements(PID, SID, ['n1'], []);
      expect(getTextBody(PID, SID, 'n1')).toBeNull();
    });

    it('leaves other nodes bodies alone', () => {
      addNode(PID, SID, sampleFields('text', { id: 'keep' }));
      addNode(PID, SID, sampleFields('text', { id: 'drop' }));
      removeElements(PID, SID, ['drop'], []);
      expect(hasBody('keep')).toBe(true);
      expect(getTextBody(PID, SID, 'drop')).toBeNull();
    });
  });

  describe('undo', () => {
    it('brings the writing back after the node is deleted', () => {
      addNode(PID, SID, sampleFields('text'));
      writePlainTextIntoBody(getTextBody(PID, SID, 'n1') as Y.XmlFragment, 'important words');
      const undoManager = createCanvasUndoManager(doc());

      runCanvasUndoBatch(PID, SID, () => {
        removeElements(PID, SID, ['n1'], []);
      });
      expect(getTextBody(PID, SID, 'n1')).toBeNull();

      undoManager.undo();
      expect(hasBody('n1')).toBe(true);
      expect(bodyToPlainText(getTextBody(PID, SID, 'n1') as Y.XmlFragment)).toBe('important words');
    });

    it('does not orphan a body when creating the node is undone', () => {
      const undoManager = createCanvasUndoManager(doc());
      runCanvasUndoBatch(PID, SID, () => {
        addNode(PID, SID, sampleFields('text'));
      });
      expect(hasBody('n1')).toBe(true);

      undoManager.undo();
      expect(doc().getMap<Y.Map<unknown>>('nodesMap').has('n1')).toBe(false);
      expect(getTextBody(PID, SID, 'n1')).toBeNull();
    });

    it('keeps typing out of the canvas undo stack', () => {
      const undoManager = createCanvasUndoManager(doc());
      runCanvasUndoBatch(PID, SID, () => {
        addNode(PID, SID, sampleFields('text'));
      });
      const before = undoManager.undoStack.length;

      writePlainTextIntoBody(getTextBody(PID, SID, 'n1') as Y.XmlFragment, 'typed by hand');
      expect(undoManager.undoStack.length).toBe(before);
    });
  });

  describe('repairing a node that has no body', () => {
    /**
     * Puts the document in the state an older node is in: the node exists, its
     * body does not.
     */
    function nodeWithoutBody(): void {
      addNode(PID, SID, sampleFields('text'));
      dataMap('n1')?.delete('body');
    }

    it('reads as absent until repaired', () => {
      nodeWithoutBody();
      expect(getTextBody(PID, SID, 'n1')).toBeNull();
    });

    it('repairs to one empty block', () => {
      nodeWithoutBody();
      const body = reseedTextBody(PID, SID, 'n1');
      expect(body).not.toBeNull();
      expect(body?.length).toBe(1);
      expect(getTextBody(PID, SID, 'n1')).not.toBeNull();
    });

    it('is idempotent, so a second caller does not wipe the first ones writing', () => {
      nodeWithoutBody();
      const first = reseedTextBody(PID, SID, 'n1') as Y.XmlFragment;
      writePlainTextIntoBody(first, 'written after the repair');
      const second = reseedTextBody(PID, SID, 'n1');
      expect(bodyToPlainText(second as Y.XmlFragment)).toBe('written after the repair');
    });

    it('returns null for a node that does not exist', () => {
      expect(reseedTextBody(PID, SID, 'nope')).toBeNull();
    });

    it('does not put the repair in the user undo stack: one undo must not delete what they just typed', () => {
      nodeWithoutBody();
      const undoManager = createCanvasUndoManager(doc());

      const body = reseedTextBody(PID, SID, 'n1') as Y.XmlFragment;
      writePlainTextIntoBody(body, 'the sentence the user just wrote');

      undoManager.undo();

      expect(hasBody('n1')).toBe(true);
      expect(bodyToPlainText(getTextBody(PID, SID, 'n1') as Y.XmlFragment)).toBe(
        'the sentence the user just wrote',
      );
    });
  });
});
