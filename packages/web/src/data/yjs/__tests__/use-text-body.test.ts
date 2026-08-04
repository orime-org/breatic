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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, getTextBody, ensureTextBody } from '@web/data/yjs/canvas-space';
import { useTextBody, useTextBodies } from '@web/data/yjs/use-text-body';
import { writePlainTextIntoBody } from '@web/data/yjs/text-body';

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
 * Yjs's observer lists, which nothing public exposes.
 *
 * Reaching for these is deliberate. The only way to tell a clean teardown from
 * a leak is to look at the observers; every outward-facing signal (what the
 * hook returns, whether a later change is reflected) is frozen by React the
 * moment the component unmounts, and so reports success either way.
 */
interface ObserverLists {
  _eH: { l: ReadonlyArray<unknown> };
  _dEH: { l: ReadonlyArray<unknown> };
}

/**
 * How many shallow observers are attached.
 * @param target - The shared type to inspect.
 * @returns The observer count.
 */
function observerCount(target: unknown): number {
  return (target as ObserverLists)._eH.l.length;
}

/**
 * How many deep observers are attached.
 * @param target - The shared type to inspect.
 * @returns The deep-observer count.
 */
function deepObserverCount(target: unknown): number {
  return (target as ObserverLists)._dEH.l.length;
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

  it('publishes on subscribe even for a node with no body at all', () => {
    // The first publish used to be skipped in exactly this case: a missing
    // body matched the starting value and read as "nothing changed", so a
    // subscriber was told nothing at all in the one case it most needs told.
    // Visible from outside through the multi-node hook, where a body-less node
    // went from having no entry to having an empty one.
    addNode(PID, SID, textNode('a'));
    dataMap('a').delete('body');

    const { result } = renderHook(() => useTextBodies(PID, SID, ['a']));

    expect(result.current.has('a')).toBe(true);
    expect(result.current.get('a')).toBe('');
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
      ensureTextBody(PID, SID, 'n1');
    });
    act(() => {
      writePlainTextIntoBody(getTextBody(PID, SID, 'n1') as Y.XmlFragment, 'written after repair');
    });

    expect(result.current).toBe('written after repair');
  });

  it('detaches both observers on unmount', () => {
    // Asserted on the observers themselves, not on what the hook returns.
    // After `unmount()` React never renders the hook again, so `result.current`
    // is frozen whatever the observers do — an assertion on it passes just as
    // happily with the cleanup deleted. A leaked deep observer is not
    // cosmetic: every text node the user scrolls past would leave one attached
    // to the module-cached document, each re-reading the whole body on every
    // keystroke by anybody.
    addNode(PID, SID, textNode('n1'));
    const body = getTextBody(PID, SID, 'n1') as Y.XmlFragment;
    const data = dataMap('n1');
    const unobserve = vi.spyOn(data, 'unobserve');
    const unobserveDeep = vi.spyOn(body, 'unobserveDeep');

    const { unmount } = subscribe('n1');
    expect(observerCount(data)).toBeGreaterThan(0);
    expect(deepObserverCount(body)).toBeGreaterThan(0);

    unmount();

    expect(unobserve).toHaveBeenCalled();
    expect(unobserveDeep).toHaveBeenCalled();
    expect(observerCount(data)).toBe(0);
    expect(deepObserverCount(body)).toBe(0);
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

    it('detaches every subscription on unmount', () => {
      // Same reason as the single-node case: after unmount the returned map is
      // frozen, so only the observers themselves can tell a clean teardown
      // from a leak.
      addNode(PID, SID, textNode('a'));
      addNode(PID, SID, textNode('b'));
      const { unmount } = renderHook(() => useTextBodies(PID, SID, ['a', 'b']));
      expect(observerCount(dataMap('a'))).toBeGreaterThan(0);
      expect(observerCount(dataMap('b'))).toBeGreaterThan(0);

      unmount();

      expect(observerCount(dataMap('a'))).toBe(0);
      expect(observerCount(dataMap('b'))).toBe(0);
      expect(deepObserverCount(getTextBody(PID, SID, 'a') as Y.XmlFragment)).toBe(0);
      expect(deepObserverCount(getTextBody(PID, SID, 'b') as Y.XmlFragment)).toBe(0);
    });
  });
});
