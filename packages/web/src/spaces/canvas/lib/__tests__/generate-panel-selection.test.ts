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
  return { panelNodeId: 'host', hostSelected: true, picking: false, ...over };
}

// Selection-driven panel lifecycle (user 2026-07-11): the panel closes when
// its host LOSES selection — through any path — and asserts the host as the
// SOLE selection on every rebinding frame (open / host switch / pick exit)
// plus while the binding has not yet been established. Adversarial rounds
// 1-3 each closed a hole here; see the module TSDoc for the history.
describe('resolvePanelSelectionAction', () => {
  it('closes on the established binding losing selection (the core rule)', () => {
    expect(
      resolvePanelSelectionAction(snap({}), snap({ hostSelected: false })),
    ).toBe('close');
  });

  it('holds while reference-pick is active (Exit is the only way out)', () => {
    expect(
      resolvePanelSelectionAction(
        snap({ picking: true }),
        snap({ hostSelected: false, picking: true }),
      ),
    ).toBe('none');
  });

  it('asserts selection on the opening frame instead of closing', () => {
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null, picking: false },
        snap({ hostSelected: false }),
      ),
    ).toBe('select');
  });

  it('asserts after a canvas remount with a persisted panel (round-1 hole)', () => {
    expect(
      resolvePanelSelectionAction(
        snap({ hostSelected: false }),
        snap({ hostSelected: false }),
      ),
    ).toBe('select');
  });

  it('asserts after a same-host reopen mid-pick (round-1 hole)', () => {
    expect(
      resolvePanelSelectionAction(
        snap({ hostSelected: false, picking: true }),
        snap({ hostSelected: false }),
      ),
    ).toBe('select');
  });

  it('asserts a fresh binding when the panel switches host A → B', () => {
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: 'a', hostSelected: true, picking: false },
        { panelNodeId: 'b', hostSelected: false, picking: false },
      ),
    ).toBe('select');
  });

  it('asserts on the opening frame even when the host is ALREADY selected (round-2 hole)', () => {
    // Click A (selected), Cmd-add an edge or another node, right-click A →
    // Generate: the host is selected but NOT the sole selection — the fresh
    // binding must assert unconditionally (idempotent when already sole).
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null, picking: false },
        snap({ hostSelected: true }),
      ),
    ).toBe('select');
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: 'a', hostSelected: true, picking: false },
        { panelNodeId: 'b', hostSelected: true, picking: false },
      ),
    ).toBe('select');
  });

  it('asserts on the pick-EXIT frame even when the host stayed selected (round-3 hole)', () => {
    // During a pick the user Cmd-clicks another node (adds to the selection,
    // host still selected). Exit must re-assert the sole selection — leaving
    // the pick is a rebinding moment exactly like opening — or the co-selected
    // node keeps its Delete-key claim under the panel.
    expect(
      resolvePanelSelectionAction(
        snap({ hostSelected: true, picking: true }),
        snap({ hostSelected: true, picking: false }),
      ),
    ).toBe('select');
  });

  it('asserts on the pick-EXIT frame when the host was deselected during the pick', () => {
    expect(
      resolvePanelSelectionAction(
        snap({ hostSelected: false, picking: true }),
        snap({ hostSelected: false, picking: false }),
      ),
    ).toBe('select');
  });

  it('does not treat a vanished host as a rebinding assert (node-gone guard owns it)', () => {
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null, picking: false },
        snap({ hostSelected: null }),
      ),
    ).toBe('none');
    expect(
      resolvePanelSelectionAction(
        snap({ hostSelected: true, picking: true }),
        snap({ hostSelected: null, picking: false }),
      ),
    ).toBe('none');
  });

  it('does nothing while the host remains selected (multi-select keeps it too)', () => {
    // Shift-clicking another node ADDS to the selection AFTER the binding is
    // established — the host is still selected, so the panel stays and the
    // user's deliberate multi-select is not fought.
    expect(resolvePanelSelectionAction(snap({}), snap({}))).toBe('none');
  });

  it('does nothing when no panel is open', () => {
    expect(
      resolvePanelSelectionAction(
        { panelNodeId: null, hostSelected: null, picking: false },
        { panelNodeId: null, hostSelected: null, picking: false },
      ),
    ).toBe('none');
  });

  it('ignores the rising edge (assert already landed)', () => {
    expect(
      resolvePanelSelectionAction(snap({ hostSelected: false }), snap({})),
    ).toBe('none');
  });
});
