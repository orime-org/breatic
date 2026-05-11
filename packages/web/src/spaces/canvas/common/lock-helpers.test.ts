/**
 * F9 — `lock-helpers` invariants. The whole point of promoting
 * these helpers to a shared module was to keep one truth across
 * `HotkeysHandler`, `NodeContextMenu`, and `ProjectCanvasContent`,
 * so the contract under test is the predicate itself, not the
 * surfaces that consume it.
 */
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import {
  NON_LOCKABLE_NODE_TYPES,
  getLockedGroupIds,
  getLockedNodeIds,
  isNodeLockable,
  isNodeLocked,
  canMutate,
} from './lock-helpers';

const fakePos = { x: 0, y: 0 };

function makeNode(
  partial: Partial<Node> & { id: string; type?: string; data?: Record<string, unknown> },
): Node {
  return {
    position: fakePos,
    data: {},
    ...partial,
  } as Node;
}

describe('NON_LOCKABLE_NODE_TYPES', () => {
  it('excludes annotation by default', () => {
    expect(NON_LOCKABLE_NODE_TYPES.has('annotation')).toBe(true);
  });

  it('does not exclude image / video / audio / generative / group', () => {
    expect(NON_LOCKABLE_NODE_TYPES.has('1002')).toBe(false);
    expect(NON_LOCKABLE_NODE_TYPES.has('1003')).toBe(false);
    expect(NON_LOCKABLE_NODE_TYPES.has('1004')).toBe(false);
    expect(NON_LOCKABLE_NODE_TYPES.has('generative')).toBe(false);
    expect(NON_LOCKABLE_NODE_TYPES.has('group')).toBe(false);
  });
});

describe('isNodeLockable', () => {
  it('returns false for annotation nodes', () => {
    expect(isNodeLockable(makeNode({ id: 'a', type: 'annotation' }))).toBe(false);
  });

  it('returns true for image / video / audio / generative / group nodes', () => {
    for (const t of ['1002', '1003', '1004', 'generative', 'group']) {
      expect(isNodeLockable(makeNode({ id: 'n', type: t }))).toBe(true);
    }
  });

  it('returns false for undefined input (defensive)', () => {
    expect(isNodeLockable(undefined)).toBe(false);
  });
});

describe('getLockedGroupIds', () => {
  it('returns an empty set when no groups exist', () => {
    const nodes = [
      makeNode({ id: '1', type: '1002', data: { locked: true } }),
      makeNode({ id: '2', type: '1003' }),
    ];
    expect(getLockedGroupIds(nodes).size).toBe(0);
  });

  it('returns the locked group ids only — image with data.locked is excluded', () => {
    const nodes = [
      makeNode({ id: 'g1', type: 'group', data: { locked: true } }),
      makeNode({ id: 'g2', type: 'group', data: { locked: false } }),
      makeNode({ id: 'img', type: '1002', data: { locked: true } }),
    ];
    const ids = getLockedGroupIds(nodes);
    expect(Array.from(ids)).toEqual(['g1']);
  });
});

describe('isNodeLocked', () => {
  it('returns true when the node carries data.locked === true', () => {
    const node = makeNode({ id: '1', type: '1002', data: { locked: true } });
    expect(isNodeLocked(node, new Set())).toBe(true);
  });

  it('returns false when data.locked is missing or false', () => {
    expect(isNodeLocked(makeNode({ id: '1', type: '1002' }), new Set())).toBe(false);
    expect(
      isNodeLocked(makeNode({ id: '1', type: '1002', data: { locked: false } }), new Set()),
    ).toBe(false);
  });

  it('treats descendants of a locked group as locked even when their own flag is false', () => {
    const node = {
      ...makeNode({ id: 'child', type: '1002', data: { locked: false } }),
      parentId: 'g1',
    } as Node;
    expect(isNodeLocked(node, new Set(['g1']))).toBe(true);
  });

  it('reads parentNode (ReactFlow v11 alias) too', () => {
    const node = {
      ...makeNode({ id: 'child', type: '1002' }),
      parentNode: 'g1',
    } as Node & { parentNode?: string };
    expect(isNodeLocked(node, new Set(['g1']))).toBe(true);
  });

  it('returns false when the parent is unrelated to the locked-group set', () => {
    const node = {
      ...makeNode({ id: 'child', type: '1002' }),
      parentId: 'unrelated-id',
    } as Node;
    expect(isNodeLocked(node, new Set(['g1']))).toBe(false);
  });
});

describe('getLockedNodeIds', () => {
  it('expands group-locked descendants + per-node locks into one set', () => {
    const nodes: Node[] = [
      makeNode({ id: 'g1', type: 'group', data: { locked: true } }),
      { ...makeNode({ id: 'a', type: '1002' }), parentId: 'g1' } as Node,
      { ...makeNode({ id: 'b', type: '1003' }), parentId: 'g1' } as Node,
      makeNode({ id: 'c', type: '1004', data: { locked: true } }), // standalone lock
      makeNode({ id: 'd', type: '1002' }), // unlocked
    ];
    const locked = getLockedNodeIds(nodes);
    expect(Array.from(locked).sort()).toEqual(['a', 'b', 'c', 'g1']);
  });

  it('returns empty set when nothing is locked', () => {
    const nodes = [
      makeNode({ id: 'a', type: '1002' }),
      makeNode({ id: 'b', type: '1003' }),
    ];
    expect(getLockedNodeIds(nodes).size).toBe(0);
  });
});

describe('canMutate', () => {
  const noLockedGroups = new Set<string>();

  it('returns true for a vanilla idle node with no locks', () => {
    expect(canMutate(makeNode({ id: 'a', type: '1002' }), noLockedGroups)).toBe(true);
  });

  it('returns false when data.locked is true', () => {
    const node = makeNode({ id: 'a', type: '1002', data: { locked: true } });
    expect(canMutate(node, noLockedGroups)).toBe(false);
  });

  it('returns false when the node is inside a locked group (transitive user lock)', () => {
    const node = makeNode({ id: 'a', type: '1002', parentId: 'g1' } as Partial<Node>);
    expect(canMutate(node, new Set(['g1']))).toBe(false);
  });

  it('returns false when operationLocks has any entry', () => {
    const node = makeNode({
      id: 'a',
      type: '1002',
      data: { operationLocks: [{ toolId: 'adjust', userId: 'u1' }] },
    });
    expect(canMutate(node, noLockedGroups)).toBe(false);
  });

  it('returns true when operationLocks is an empty array', () => {
    const node = makeNode({
      id: 'a',
      type: '1002',
      data: { operationLocks: [] },
    });
    expect(canMutate(node, noLockedGroups)).toBe(true);
  });

  it('returns true when operationLocks is missing (older Yjs row)', () => {
    const node = makeNode({ id: 'a', type: '1002', data: {} });
    expect(canMutate(node, noLockedGroups)).toBe(true);
  });

  it('returns false when state is handling', () => {
    const node = makeNode({
      id: 'a',
      type: '1002',
      data: { state: 'handling' },
    });
    expect(canMutate(node, noLockedGroups)).toBe(false);
  });

  it('returns true when state is idle (explicit)', () => {
    const node = makeNode({
      id: 'a',
      type: '1002',
      data: { state: 'idle' },
    });
    expect(canMutate(node, noLockedGroups)).toBe(true);
  });

  it('union semantics — any layer engaged blocks mutation', () => {
    // operationLock set, but locked + handling are both default → blocked
    const a = makeNode({
      id: 'a',
      type: '1002',
      data: { operationLocks: [{ toolId: 'adjust', userId: 'u1' }] },
    });
    // locked set, but operationLocks empty + idle → blocked
    const b = makeNode({ id: 'b', type: '1002', data: { locked: true } });
    // handling set, but locked false + operationLocks empty → blocked
    const c = makeNode({
      id: 'c',
      type: '1002',
      data: { state: 'handling' },
    });
    expect(canMutate(a, noLockedGroups)).toBe(false);
    expect(canMutate(b, noLockedGroups)).toBe(false);
    expect(canMutate(c, noLockedGroups)).toBe(false);
  });
});
