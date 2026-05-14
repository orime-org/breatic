/**
 * Generative node primary downstream edge uniqueness invariant
 * (critical path — see `04-generative-node-controls.md` §5).
 *
 * Each generative node has at most ONE outgoing edge with
 * `isPrimary === true`. `setPrimaryEdge(nodeId, edgeId)` must be
 * atomic in Y.Doc transaction (no observable intermediate state
 * with two primary edges).
 *
 * M0 SCAFFOLD — fill in M1 when canvas-space.ts adapter exposes
 * setPrimaryEdge helper. Property-based test will fuzz multiple
 * setPrimary calls and assert the invariant after each transaction.
 */

import { describe, it } from 'vitest';

describe.skip('Primary downstream edge uniqueness (M1)', () => {
  it('a fresh generative node has zero primary edges', () => {
    // TODO M1: create node, assert no edges
  });

  it('setPrimaryEdge promotes one edge and demotes the previous primary', () => {
    // TODO M1: create 3 edges, setPrimary on edge A → A primary, B/C not;
    //         setPrimary on B → B primary, A/C not.
  });

  it('atomic — no observable state with two primary edges', () => {
    // TODO M1: subscribe to edge updates,
    //         setPrimary on B while A is currently primary,
    //         observer never sees both isPrimary=true.
  });
});
