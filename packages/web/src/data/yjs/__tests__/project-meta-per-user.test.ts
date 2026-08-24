// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { nextActiveAfterVanish } from '@web/data/yjs/project-meta';

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
 * `nextActiveAfterVanish` stayed on the client, and so did its tests. It
 * answers a question only the client can answer: which tab to activate
 * when the active one disappears. Which tab is active is local window
 * state, deliberately never shared (2026-07-11), so nobody else can fix
 * it for us. It used to also return the vanished ids for the caller to
 * close; that half went away with the client writes.
 */
describe('nextActiveAfterVanish — which tab to show when the active one is gone', () => {
  it('active space deleted → the first still-live open tab', () => {
    // openTabIds [a,b,c], a was deleted and was active. Activate b, the
    // first remaining visible tab.
    expect(nextActiveAfterVanish(['a', 'b', 'c'], new Set(['b', 'c']), 'a')).toBe(
      'b',
    );
  });

  it('active deleted with no other open tab still live → null (empty state)', () => {
    // Only tab a was open and it was deleted; the project still has space x
    // (>=1 guaranteed) but it is not in this user's open tabs.
    expect(nextActiveAfterVanish(['a'], new Set(['x']), 'a')).toBeNull();
  });

  it('deleting a NON-active space leaves the active tab untouched', () => {
    expect(
      nextActiveAfterVanish(['a', 'b'], new Set(['a']), 'a'),
    ).toBeUndefined();
  });

  it('no vanished spaces → nothing to do', () => {
    expect(
      nextActiveAfterVanish(['a', 'b'], new Set(['a', 'b']), 'a'),
    ).toBeUndefined();
  });

  // This function answers ONE question: has the active Space disappeared from
  // the project? It must not also try to answer "is the active id in my tab
  // list", because those two look identical in the data and mean opposite
  // things. An id that is live but absent from `openTabIds` is either a tab
  // that was just closed — where the effective-active fallback already moves
  // the view, `resolveEffectiveActiveSpace` — or a Space that is being opened
  // right now, whose `tab:open` broadcast has not landed yet. Reactivating on
  // that shape breaks the second case: the user picks a Space and gets thrown
  // back to the first tab. Verified in a real browser on 2026-08-03.

  it('an active id that is live but not in the list is left alone (it is being opened)', () => {
    expect(
      nextActiveAfterVanish(['b', 'c'], new Set(['a', 'b', 'c']), 'a'),
    ).toBeUndefined();
  });

  it('the same holds when the list is empty — a first tab on its way in', () => {
    expect(nextActiveAfterVanish([], new Set(['a']), 'a')).toBeUndefined();
  });

  it('null active → nothing to activate', () => {
    expect(
      nextActiveAfterVanish(['a', 'b'], new Set(['a']), null),
    ).toBeUndefined();
  });
});
