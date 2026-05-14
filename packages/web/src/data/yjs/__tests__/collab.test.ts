/**
 * Yjs cross-instance collaboration invariant (critical path).
 *
 * Two Y.Docs syncing via in-memory transport must converge:
 * node create / delete / data mutate on doc A → visible on doc B.
 *
 * M0 SCAFFOLD — fill in M1 when canvas-space.ts adapter API
 * stabilizes against the new Page shell. Will use `y-protocols/sync`
 * stub transport (no real WebSocket) for hermetic tests.
 */

import { describe, it } from 'vitest';

describe.skip('Yjs 2-doc sync (M1)', () => {
  it('node created on doc A appears on doc B', () => {
    // TODO M1: build two Y.Docs + relay updates between them,
    //         add a node via canvas-space helper on A,
    //         assert it materializes on B.
  });

  it('concurrent edits converge (last-write-wins on data field)', () => {
    // TODO M1: parallel data mutations on both docs,
    //         after sync, assert deterministic final state.
  });

  it('delete on A removes from B', () => {
    // TODO M1: create on both, delete on A, assert B sees deletion.
  });
});
