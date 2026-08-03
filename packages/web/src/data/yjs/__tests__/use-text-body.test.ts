// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Subscribing to a text node's body (#1774, design section 9.1).
 *
 * The body deliberately stays out of the node-view projection, which is what
 * makes a keystroke re-render nothing on the canvas. The price is that nobody
 * gets the text for free any more, so the two consumers that need it — the node
 * itself and the generation panel's `@` reference — subscribe through this one
 * hook.
 *
 * Two layers, and both are load-bearing:
 *
 * - The fragment needs `observeDeep`. A remote collaborator typing inside an
 *   existing paragraph changes something nested; a shallow observer on the
 *   fragment never fires, and the text silently stops updating.
 * - The node's data map needs a shallow observer. The `body` key can be
 *   REPLACED — a node that had none gets repaired, possibly by the other side —
 *   and whoever is still holding the old fragment is bound to an object that is
 *   no longer in the document. Without this layer they never see another word.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, getTextBody, reseedTextBody } from '@web/data/yjs/canvas-space';
import { useTextBody, useTextBodies } from '@web/data/yjs/use-text-body';
import { newSeededBody, writePlainTextIntoBody } from '@web/data/yjs/text-body';

const PID = 'p1';
const SID = 's1';

/**
 * A text node fixture.
 * @param id - The node id.
 * @returns Complete wire node fields.
 */
function textNode(id: string): CanvasNodeFields {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      name: 'N',
      createdAt: 1,
      createdBy: 'u',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
    },
  };
}

/**
 * The canvas document under test.
 * @returns The fixture Y.Doc.
 */
function doc(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

/**
 * A node's data map.
 * @param nodeId - The node to look up.
 * @returns The data map.
 */
function dataMap(nodeId: string): Y.Map<unknown> {
  return doc().getMap<Y.Map<unknown>>('nodesMap').get(nodeId)?.get('data') as Y.Map<unknown>;
}

/**
 * Render the hook for a node.
 * @param nodeId - The node whose body to subscribe to.
 * @returns The render result.
 */
function subscribe(nodeId: string): ReturnType<typeof renderHook<string, unknown>> {
  return renderHook(() => useTextBody(PID, SID, nodeId));
}

describe('useTextBody (#1774 section 9.1)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('returns the body as plain text on first render', () => {
    addNode(PID, SID, textNode('n1'));
    writePlainTextIntoBody(getTextBody(PID, SID, 'n1') as Y.XmlFragment, 'already written');

    const { result } = subscribe('n1');
    expect(result.current).toBe('already written');
  });

  it('returns the empty string for a node whose body was never seeded', () => {
    addNode(PID, SID, textNode('n1'));
    dataMap('n1').delete('body');

    const { result } = subscribe('n1');
    expect(result.current).toBe('');
  });

  it('returns the empty string for a node that does not exist', () => {
    expect(subscribe('nope').result.current).toBe('');
  });

  it('updates when a collaborator types inside an existing paragraph', () => {
    addNode(PID, SID, textNode('n1'));
    const body = getTextBody(PID, SID, 'n1') as Y.XmlFragment;
    writePlainTextIntoBody(body, 'first draft');

    const { result } = subscribe('n1');
    act(() => {
      (body.get(0) as Y.XmlElement).insert(0, [new Y.XmlText('the ')]);
    });

    // A shallow observer on the fragment would not have fired here: the change
    // is one level down, inside the paragraph.
    expect(result.current).toBe('the first draft');
  });

  it('updates when a whole paragraph is added', () => {
    addNode(PID, SID, textNode('n1'));
    const body = getTextBody(PID, SID, 'n1') as Y.XmlFragment;
    writePlainTextIntoBody(body, 'one');

    const { result } = subscribe('n1');
    act(() => {
      writePlainTextIntoBody(body, 'one\ntwo');
    });
    expect(result.current).toBe('one\ntwo');
  });

  it('follows the body when the key is replaced, so a repaired node still updates', () => {
    addNode(PID, SID, textNode('n1'));
    dataMap('n1').delete('body');

    const { result } = subscribe('n1');
    expect(result.current).toBe('');

    // What the losing side of a concurrent repair sees: their key is swapped
    // for the winner's fragment. Staying bound to the old one means never
    // seeing another word.
    act(() => {
      reseedTextBody(PID, SID, 'n1');
    });
    act(() => {
      writePlainTextIntoBody(getTextBody(PID, SID, 'n1') as Y.XmlFragment, 'written after repair');
    });

    expect(result.current).toBe('written after repair');
  });

  it('stops updating after unmount, both layers', () => {
    addNode(PID, SID, textNode('n1'));
    const body = getTextBody(PID, SID, 'n1') as Y.XmlFragment;

    const { result, unmount } = subscribe('n1');
    unmount();

    act(() => {
      writePlainTextIntoBody(body, 'written after unmount');
      dataMap('n1').set('body', newSeededBody());
    });
    expect(result.current).toBe('');
  });

  it('switches to the other node when the id changes', () => {
    addNode(PID, SID, textNode('a'));
    addNode(PID, SID, textNode('b'));
    writePlainTextIntoBody(getTextBody(PID, SID, 'a') as Y.XmlFragment, 'from a');
    writePlainTextIntoBody(getTextBody(PID, SID, 'b') as Y.XmlFragment, 'from b');

    const { result, rerender } = renderHook(({ id }) => useTextBody(PID, SID, id), {
      initialProps: { id: 'a' },
    });
    expect(result.current).toBe('from a');

    rerender({ id: 'b' });
    expect(result.current).toBe('from b');
  });

  describe('several bodies at once, for the generation panel', () => {
    it('returns each subscribed node\'s text', () => {
      addNode(PID, SID, textNode('a'));
      addNode(PID, SID, textNode('b'));
      writePlainTextIntoBody(getTextBody(PID, SID, 'a') as Y.XmlFragment, 'from a');
      writePlainTextIntoBody(getTextBody(PID, SID, 'b') as Y.XmlFragment, 'from b');

      const { result } = renderHook(() => useTextBodies(PID, SID, ['a', 'b']));
      expect(result.current.get('a')).toBe('from a');
      expect(result.current.get('b')).toBe('from b');
    });

    it('updates when any of them changes', () => {
      addNode(PID, SID, textNode('a'));
      addNode(PID, SID, textNode('b'));

      const { result } = renderHook(() => useTextBodies(PID, SID, ['a', 'b']));
      act(() => {
        writePlainTextIntoBody(getTextBody(PID, SID, 'b') as Y.XmlFragment, 'edited');
      });
      expect(result.current.get('b')).toBe('edited');
    });

    it('follows the set as references come and go', () => {
      addNode(PID, SID, textNode('a'));
      addNode(PID, SID, textNode('b'));
      writePlainTextIntoBody(getTextBody(PID, SID, 'a') as Y.XmlFragment, 'from a');
      writePlainTextIntoBody(getTextBody(PID, SID, 'b') as Y.XmlFragment, 'from b');

      const { result, rerender } = renderHook(
        ({ ids }) => useTextBodies(PID, SID, ids),
        { initialProps: { ids: ['a'] as ReadonlyArray<string> } },
      );
      expect(result.current.get('b')).toBeUndefined();

      rerender({ ids: ['a', 'b'] });
      expect(result.current.get('b')).toBe('from b');
    });

    it('keeps its subscriptions across a re-render with an equal but fresh array', () => {
      // The caller rebuilds this array from the edge list on every render. If
      // an equal array counted as a change, every observer would be dropped and
      // re-attached between two keystrokes.
      addNode(PID, SID, textNode('a'));
      const { result, rerender } = renderHook(
        ({ ids }) => useTextBodies(PID, SID, ids),
        { initialProps: { ids: ['a'] as ReadonlyArray<string> } },
      );
      const first = result.current;

      rerender({ ids: ['a'] });
      expect(result.current).toBe(first);

      act(() => {
        writePlainTextIntoBody(getTextBody(PID, SID, 'a') as Y.XmlFragment, 'still live');
      });
      expect(result.current.get('a')).toBe('still live');
    });

    it('stops updating after unmount', () => {
      addNode(PID, SID, textNode('a'));
      const { result, unmount } = renderHook(() => useTextBodies(PID, SID, ['a']));
      unmount();
      act(() => {
        writePlainTextIntoBody(getTextBody(PID, SID, 'a') as Y.XmlFragment, 'after unmount');
      });
      expect(result.current.get('a')).toBe('');
    });
  });
});
