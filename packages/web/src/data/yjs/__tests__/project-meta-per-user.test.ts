// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { planVanishedSpaceReconcile } from '@web/data/yjs/project-meta';

/**
 * What is left here after the open-tab list moved behind RPCs.
 *
 * This file used to hold the state machine for `perUser[userId].openTabIds`
 * — append, close, idempotence, the first-write snapshot, and two
 * property tests over random operation sequences. The client does not
 * write that list any more (task #27): every change goes through
 * `tab:open` / `tab:close`, and the invariants moved to the server with
 * the logic, in `collab/src/__tests__/space-rpc.test.ts` under
 * "tab:open / tab:close". They are stricter there, because getting them
 * wrong server-side is persisted for every machine on the account
 * instead of living in one browser tab until a reload.
 *
 * `planVanishedSpaceReconcile` stayed on the client, and so did its
 * tests. It answers a question only the client can answer: which tab to
 * activate when the active one disappears. Which tab is active is local
 * window state, deliberately never shared (2026-07-11), so nobody else
 * can fix it for us. Its pruning half is no longer used — deleting a
 * Space clears it from everyone's list server-side, in the same
 * broadcast — but the function still returns it and the cases below
 * still cover it.
 */
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
