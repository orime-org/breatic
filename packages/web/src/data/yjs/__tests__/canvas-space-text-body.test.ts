// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A text node's body in the canvas document (#1774, design sections 5 and 6).
 *
 * The body is a `Y.XmlFragment` living in a top-level `textBodies` map rather
 * than under the node, because the canvas observer is deep and a keystroke
 * under the node recomputes every node on the board. Moving it out means four
 * things the node subtree had been providing for free have to be restored
 * explicitly, and each one is a way to lose a user's writing:
 *
 * - Undo scope. Delete a node, press undo, and the body has to come back.
 * - Lifecycle. Deletion has two exits and undoing a creation must not orphan.
 * - Seeding origin. Birth-seeding belongs to the user's act of creating a node
 *   and must undo with it; repairing a node that has no body is the system
 *   fixing itself and must NOT land in the user's undo stack, or one press
 *   deletes the paragraph they just typed.
 * - Typing must stay out of the canvas undo stack entirely; the editor has its
 *   own history.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  createCanvasUndoManager,
  removeElements,
  removeNode,
  runCanvasUndoBatch,
  getTextBody,
  reseedTextBody,
  TEXT_BODIES_KEY,
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
 * Whether the top-level map still holds a body for this node.
 * @param nodeId - The node to look up.
 * @returns True when a body is present.
 */
function hasBody(nodeId: string): boolean {
  return doc().getMap<Y.XmlFragment>(TEXT_BODIES_KEY).has(nodeId);
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

    it('leaves other modalities alone', () => {
      addNode(PID, SID, sampleFields('image', { id: 'img' }));
      expect(hasBody('img')).toBe(false);
      expect(getTextBody(PID, SID, 'img')).toBeNull();
    });

    it('keeps the body out of the node subtree, so typing cannot wake the canvas observer', () => {
      addNode(PID, SID, sampleFields('text'));
      const nodesMap = doc().getMap<Y.Map<unknown>>('nodesMap');
      let fired = 0;
      nodesMap.observeDeep(() => {
        fired += 1;
      });

      const body = getTextBody(PID, SID, 'n1') as Y.XmlFragment;
      for (let i = 0; i < 10; i += 1) {
        (body.get(0) as Y.XmlElement).insert(0, [new Y.XmlText('x')]);
      }
      expect(fired).toBe(0);

      // The observer is alive: a real node change still reaches it.
      nodesMap.get('n1')?.set('name', 'renamed');
      expect(fired).toBe(1);
    });
  });

  describe('deletion takes the body with it', () => {
    it('through removeNode', () => {
      addNode(PID, SID, sampleFields('text'));
      expect(hasBody('n1')).toBe(true);
      removeNode(PID, SID, 'n1');
      expect(hasBody('n1')).toBe(false);
    });

    it('through removeElements, which is where the Delete key goes', () => {
      addNode(PID, SID, sampleFields('text'));
      removeElements(PID, SID, ['n1'], []);
      expect(hasBody('n1')).toBe(false);
    });

    it('leaves other nodes bodies alone', () => {
      addNode(PID, SID, sampleFields('text', { id: 'keep' }));
      addNode(PID, SID, sampleFields('text', { id: 'drop' }));
      removeElements(PID, SID, ['drop'], []);
      expect(hasBody('keep')).toBe(true);
      expect(hasBody('drop')).toBe(false);
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
      expect(hasBody('n1')).toBe(false);

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
      expect(hasBody('n1')).toBe(false);
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
     * @returns Nothing.
     */
    function nodeWithoutBody(): void {
      addNode(PID, SID, sampleFields('text'));
      doc().getMap<Y.XmlFragment>(TEXT_BODIES_KEY).delete('n1');
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
