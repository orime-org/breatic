// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import {
  resolvePanelSelectionAction,
  type PanelSelectionSnapshot,
} from '@web/spaces/canvas/lib/generate-panel-selection';

/**
 * Builds a snapshot with defaults for terser cases.
 * @param over - Field overrides.
 * @returns The snapshot.
 */
function snap(over: Partial<PanelSelectionSnapshot>): PanelSelectionSnapshot {
  return { panelNodeId: 'host', hostSelected: true, ...over };
}

// Selection-driven panel lifecycle (user 2026-07-11): the panel closes when
// its host LOSES selection — through any path — and keeps ASSERTING the host
// selection while the binding has not yet been established (round-1
// adversarial holes: canvas remount / same-host reopen left a one-shot open
// effect unfired and the guard permanently disarmed). See the module TSDoc.
describe('resolvePanelSelectionAction', () => {
  it('closes on the established binding losing selection (the core rule)', () => {
    expect(
      resolvePanelSelectionAction(snap({}), snap({ hostSelected: false }), false),
    ).toBe('close');
  });

  it('holds while reference-pick is active (Exit is the only way out)', () => {
    expect(
      resolvePanelSelectionAction(snap({}), snap({ hostSelected: false }), true),
    ).toBe('none');
  });

  it('asserts selection on the opening frame instead of closing', () => {
    // The open gesture writes the store id first; the machine must select the
    // host, not treat "open + unselected" as a lost binding.
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null },
        snap({ hostSelected: false }),
        false,
      ),
    ).toBe('select');
  });

  it('asserts selection after a canvas remount with a persisted panel (adversarial hole 1)', () => {
    // Space-tab round-trip: the store keeps the panel id across the canvas
    // unmount; on remount the buffer mirrors back with the host UNSELECTED and
    // the previous frame never saw it selected — the machine must re-assert,
    // not sit disarmed forever.
    expect(
      resolvePanelSelectionAction(
        snap({ hostSelected: false }),
        snap({ hostSelected: false }),
        false,
      ),
    ).toBe('select');
  });

  it('asserts selection after a same-host reopen mid-pick (adversarial hole 2)', () => {
    // Pick moved selection to a candidate (prev {host,false}); re-choosing
    // Generate on the SAME host clears the pick — the machine must re-assert
    // the host selection even though the id never changed.
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: 'host', hostSelected: false },
        { panelNodeId: 'host', hostSelected: false },
        false,
      ),
    ).toBe('select');
  });

  it('asserts a fresh binding when the panel switches host A → B', () => {
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: 'a', hostSelected: true },
        { panelNodeId: 'b', hostSelected: false },
        false,
      ),
    ).toBe('select');
  });

  it('asserts on the opening frame even when the host is ALREADY selected (round-2 hole)', () => {
    // Round-2 adversarial: click A (selected), Cmd-add an edge or another
    // node, right-click A → Generate. The host is selected but NOT the sole
    // selection — the co-selected edge keeps its scissors + Delete claim
    // under the panel unless the fresh binding asserts unconditionally.
    // The assert is idempotent (reference-stable when already sole), so
    // selecting an already-sole host costs nothing.
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null },
        snap({ hostSelected: true }),
        false,
      ),
    ).toBe('select');
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: 'a', hostSelected: true },
        { panelNodeId: 'b', hostSelected: true },
        false,
      ),
    ).toBe('select');
  });

  it('does not assert a fresh binding on a vanished host (node-gone guard owns it)', () => {
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null },
        snap({ hostSelected: null }),
        false,
      ),
    ).toBe('none');
  });

  it('does nothing while the host remains selected (multi-select keeps it too)', () => {
    // Shift-clicking another node ADDS to the selection — the host is still
    // selected, so the binding holds.
    expect(resolvePanelSelectionAction(snap({}), snap({}), false)).toBe('none');
  });

  it('leaves a vanished host to the node-gone guard (hostSelected null)', () => {
    expect(
      resolvePanelSelectionAction(snap({}), snap({ hostSelected: null }), false),
    ).toBe('none');
  });

  it('does nothing when no panel is open', () => {
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null },
        { panelNodeId: null, hostSelected: null },
        false,
      ),
    ).toBe('none');
  });

  it('ignores the rising edge (assert already landed)', () => {
    expect(
      resolvePanelSelectionAction(snap({ hostSelected: false }), snap({}), false),
    ).toBe('none');
  });
});
