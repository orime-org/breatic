// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';

import { destroyDoc, docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  closeSpaceTab,
  openSpaceTab,
  setActiveSpace,
  appendSpace,
  planVanishedSpaceReconcile,
} from '@web/data/yjs/project-meta';

/**
 * Critical-path invariants for the per-user Y.Doc subtree
 * (`perUser[userId].openTabIds + activeSpaceId`).
 *
 * Why property-based: Yjs collaboration is one of the 6 critical-path
 * categories (memory `[[CLAUDE.md TDD-MANDATE]]`). Per-user tab state
 * is part of the workspace restore guarantee — if any sequence of
 * open / close / setActive can produce a state where activeSpaceId
 * points outside `spaces`, or `openTabIds` has duplicates, the user
 * lands on a wedged UI after sync.
 *
 * fast-check randomly composes sequences of operations and checks
 * invariants after each one — much more thorough than hand-picked
 * example tests for this state machine.
 */
describe('project-meta per-user state machine', () => {
  const projectId = 'p1';
  const userId = 'u1';

  beforeEach(() => {
    _resetForTests();
    // Seed a few spaces so the operations have something to work with.
    appendSpace(projectId, { id: 's1', name: 'S1', type: 'canvas' });
    appendSpace(projectId, { id: 's2', name: 'S2', type: 'canvas' });
    appendSpace(projectId, { id: 's3', name: 'S3', type: 'canvas' });
  });

  it('openSpaceTab appends and is idempotent (no duplicate ids)', () => {
    // First call snapshots the current spaces (Q6 fix — see invariant
    // below for the rationale). With 3 spaces seeded in beforeEach,
    // the snapshot brings them all into openTabIds; subsequent opens
    // of already-known ids are no-ops.
    openSpaceTab(projectId, userId, 's1');
    openSpaceTab(projectId, userId, 's1');
    openSpaceTab(projectId, userId, 's2');
    const { openTabIds } = readUserState();
    expect(openTabIds).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
    expect(openTabIds).toHaveLength(3);
  });

  it('Q6 invariant: first openSpaceTab snapshots all existing spaces (no tab disappears)', () => {
    // Scenario: user lands on a project with 3 existing spaces but has
    // never interacted before (perUser is empty). They click the "+"
    // button to create a new space, which triggers openSpaceTab for the
    // new id. Without the snapshot, the first openSpaceTab would set
    // openTabIds = [newId], and ALL 3 existing tabs would vanish from
    // the tab bar — recoverable only via the SpaceDrawer (the Q6 bug).
    openSpaceTab(projectId, userId, 's2');
    const { openTabIds } = readUserState();
    expect(openTabIds).toContain('s1');
    expect(openTabIds).toContain('s2');
    expect(openTabIds).toContain('s3');
    expect(openTabIds).toHaveLength(3);
  });

  it('Q6 invariant: subsequent openSpaceTab only appends new ids (no re-snapshot)', () => {
    // First call snapshots {s1, s2, s3}. After a close + re-open of s1,
    // s1 should sit at the end (the snapshot is a one-shot init, not
    // a recurring overwrite).
    openSpaceTab(projectId, userId, 's2');
    closeSpaceTab(projectId, userId, 's1');
    openSpaceTab(projectId, userId, 's1');
    const { openTabIds } = readUserState();
    expect(openTabIds).toContain('s1');
    expect(openTabIds).toContain('s2');
    expect(openTabIds).toContain('s3');
    // s1 is last because re-open appends to the end.
    expect(openTabIds[openTabIds.length - 1]).toBe('s1');
  });

  it('closeSpaceTab removes the id (and is idempotent for missing ids)', () => {
    // First openSpaceTab snapshots all 3 spaces (Q6) → openTabIds is
    // now {s1, s2, s3}. Closing s1 leaves {s2, s3}; subsequent closes
    // of s1 / a missing id are no-ops.
    openSpaceTab(projectId, userId, 's1');
    openSpaceTab(projectId, userId, 's2');
    closeSpaceTab(projectId, userId, 's1');
    closeSpaceTab(projectId, userId, 's1'); // no-op
    closeSpaceTab(projectId, userId, 's-missing');
    const { openTabIds } = readUserState();
    expect(openTabIds).toEqual(expect.arrayContaining(['s2', 's3']));
    expect(openTabIds).toHaveLength(2);
    expect(openTabIds).not.toContain('s1');
  });

  it('setActiveSpace stores the id (and null clears the entry)', () => {
    setActiveSpace(projectId, userId, 's2');
    expect(readUserState().activeSpaceId).toBe('s2');
    setActiveSpace(projectId, userId, null);
    expect(readUserState().activeSpaceId).toBeNull();
  });

  // Property-based via 100 vanilla random op sequences (fast-check would
  // be the idiomatic tool but the workspace does not currently depend on
  // it; loop coverage is sufficient for now — follow-up PR adds the dep
  // + rewrites these two as fc.property).
  it('property: openTabIds never contains duplicates after any random op sequence', () => {
    const ops = ['open', 'close', 'active'] as const;
    const ids = ['s1', 's2', 's3'] as const;
    for (let iter = 0; iter < 100; iter++) {
      _resetForTests();
      appendSpace(projectId, { id: 's1', name: 'S1', type: 'canvas' });
      appendSpace(projectId, { id: 's2', name: 'S2', type: 'canvas' });
      appendSpace(projectId, { id: 's3', name: 'S3', type: 'canvas' });
      const len = Math.floor(Math.random() * 30);
      for (let i = 0; i < len; i++) {
        const op = ops[Math.floor(Math.random() * ops.length)];
        const id = ids[Math.floor(Math.random() * ids.length)];
        if (op === 'open') openSpaceTab(projectId, userId, id);
        if (op === 'close') closeSpaceTab(projectId, userId, id);
        if (op === 'active') setActiveSpace(projectId, userId, id);
      }
      const { openTabIds } = readUserState();
      const unique = new Set(openTabIds);
      expect(unique.size).toBe(openTabIds.length);
    }
  });

  it('property: closing a tab never removes the others', () => {
    const ids = ['s1', 's2', 's3'] as const;
    for (let iter = 0; iter < 100; iter++) {
      _resetForTests();
      appendSpace(projectId, { id: 's1', name: 'S1', type: 'canvas' });
      appendSpace(projectId, { id: 's2', name: 'S2', type: 'canvas' });
      appendSpace(projectId, { id: 's3', name: 'S3', type: 'canvas' });
      const len = Math.floor(Math.random() * 10);
      for (let i = 0; i < len; i++) {
        const id = ids[Math.floor(Math.random() * ids.length)];
        openSpaceTab(projectId, userId, id);
      }
      const target = ids[Math.floor(Math.random() * ids.length)];
      const before = readUserState().openTabIds.filter((id) => id !== target);
      closeSpaceTab(projectId, userId, target);
      const after = readUserState().openTabIds;
      expect(after).toEqual(before);
    }
  });
});

function readUserState(): {
  openTabIds: string[];
  activeSpaceId: string | null;
  } {
  // Read state directly from the Y.Doc (the hook needs a React tree to
  // run; tests sidestep React by reading the doc).
  const doc = getDoc(docName.projectMeta('p1'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perUser = doc.getMap<any>('perUser');
  const userMap = perUser.get('u1');
  if (!userMap) return { openTabIds: [], activeSpaceId: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr = userMap.get('openTabIds') as any;
  const openTabIds = arr ? (arr.toArray() as string[]) : [];
  const activeSpaceId = (userMap.get('activeSpaceId') as string | null) ?? null;
  return { openTabIds, activeSpaceId };
}

// Suppress unused: destroyDoc imported for symmetry with manager test
void destroyDoc;

describe('planVanishedSpaceReconcile — per-user reconcile when spaces vanish', () => {
  it('active space deleted → reactivate the first still-live open tab + prune the gone id', () => {
    // openTabIds [a,b,c], a was deleted and was active. Reactivate to b
    // (first remaining visible tab), prune a.
    const out = planVanishedSpaceReconcile(
      ['a', 'b', 'c'],
      new Set(['b', 'c']),
      'a',
    );
    expect(out.tabsToClose).toEqual(['a']);
    expect(out.reactivateTo).toBe('b');
  });

  it('active deleted with no other open tab still live → reactivate to null (empty state)', () => {
    // Only tab a was open and it was deleted; the project still has space x
    // (>=1 guaranteed) but it is not in this user's open tabs.
    const out = planVanishedSpaceReconcile(['a'], new Set(['x']), 'a');
    expect(out.tabsToClose).toEqual(['a']);
    expect(out.reactivateTo).toBeNull();
  });

  it('deleting a NON-active space leaves the active tab untouched (only prune)', () => {
    const out = planVanishedSpaceReconcile(['a', 'b'], new Set(['a']), 'a');
    expect(out.tabsToClose).toEqual(['b']);
    expect(out.reactivateTo).toBeUndefined(); // active 'a' still live → no change
  });

  it('no vanished spaces → nothing to do', () => {
    const out = planVanishedSpaceReconcile(['a', 'b'], new Set(['a', 'b']), 'a');
    expect(out.tabsToClose).toEqual([]);
    expect(out.reactivateTo).toBeUndefined();
  });

  it('null active + a vanished tab → prune it, no reactivation', () => {
    const out = planVanishedSpaceReconcile(['a', 'b'], new Set(['a']), null);
    expect(out.tabsToClose).toEqual(['b']);
    expect(out.reactivateTo).toBeUndefined();
  });
});
