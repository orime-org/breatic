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

  // A tab stops being the right thing to show for two reasons, not one: the
  // Space was deleted, or the tab was closed. Both mean the same thing — the
  // active id no longer names a tab this user has open — so both belong to
  // this one rule. Closing used to move the active tab from inside the close
  // handler instead, the moment the request went out, which put it on the
  // wrong side of the line: a close that FAILS leaves the tab on screen but
  // had already switched the view away from it (design §6.6.2: on failure
  // "nothing moves"). Driving it from the list is what makes the failure
  // path correct, because a failed close never changes the list.

  it('active tab closed while the Space still exists → reactivate the first remaining open tab', () => {
    // The broadcast has removed 'a' from this user's list; the Space itself
    // is untouched and still in the project.
    const out = planVanishedSpaceReconcile(
      ['b', 'c'],
      new Set(['a', 'b', 'c']),
      'a',
    );
    expect(out.reactivateTo).toBe('b');
  });

  it('the only open tab was closed → reactivate to null (empty state)', () => {
    const out = planVanishedSpaceReconcile([], new Set(['a']), 'a');
    expect(out.reactivateTo).toBeNull();
  });

  it('closing a NON-active tab leaves the active one alone', () => {
    const out = planVanishedSpaceReconcile(['a'], new Set(['a', 'b']), 'a');
    expect(out.reactivateTo).toBeUndefined();
  });

  it('null active + a vanished tab → prune it, no reactivation', () => {
    const out = planVanishedSpaceReconcile(['a', 'b'], new Set(['a']), null);
    expect(out.tabsToClose).toEqual(['b']);
    expect(out.reactivateTo).toBeUndefined();
  });
});
