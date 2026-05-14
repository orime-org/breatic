/**
 * Node state-machine priority invariant (critical path).
 *
 * Per `01-canvas-nodes.md` §2 + ADR `mini-tool-state-machine`:
 *   locked > handling > error > selected > idle
 *
 * Property-based (fast-check) — verifies the priority chain holds
 * for any combination of state flags.
 *
 * M0 SCAFFOLD — fill in M1 when the node-state derivation helper
 * is implemented (spaces/canvas/common/node-state.ts). Until then
 * there's no `computeNodeVisual` to test.
 */

import { describe, it } from 'vitest';
// import fc from 'fast-check';

describe.skip('Node state priority chain (M1, property-based)', () => {
  it('locked overrides everything', () => {
    // TODO M1:
    // fc.assert(fc.property(
    //   fc.record({
    //     locked: fc.boolean(),
    //     handling: fc.boolean(),
    //     errorMessage: fc.option(fc.string()),
    //     selected: fc.boolean(),
    //   }),
    //   (state) => {
    //     const visual = computeNodeVisual(state);
    //     if (state.locked) return visual === 'locked';
    //     if (state.handling) return visual === 'handling';
    //     if (state.errorMessage) return visual === 'error';
    //     if (state.selected) return visual === 'selected';
    //     return visual === 'idle';
    //   },
    // ));
  });

  it('error and handling are mutually exclusive', () => {
    // TODO M1: data.state === 'handling' && errorMessage !== null
    //          must never happen (asserts adapter layer enforces this).
  });
});
