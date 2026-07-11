// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import {
  shouldCloseOnSelectionEdge,
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
// its host LOSES selection — through any path (another node clicked, empty
// canvas clicked, menu-create / paste auto-selecting the new node, grouping).
// Edge-triggered on purpose: see the module TSDoc.
describe('shouldCloseOnSelectionEdge', () => {
  it('closes on the host selected → deselected edge (the core rule)', () => {
    expect(
      shouldCloseOnSelectionEdge(
        snap({}),
        snap({ hostSelected: false }),
        false,
      ),
    ).toBe(true);
  });

  it('stays open while reference-pick is active (Exit is the only way out)', () => {
    expect(
      shouldCloseOnSelectionEdge(snap({}), snap({ hostSelected: false }), true),
    ).toBe(false);
  });

  it('does NOT close on the opening frame (no panel before, not yet selected)', () => {
    // The open gesture writes the store id first; the selection effect lands a
    // beat later. A level rule would kill the panel here — the edge rule must
    // not.
    expect(
      shouldCloseOnSelectionEdge(
        { panelNodeId: null, hostSelected: null },
        snap({ hostSelected: false }),
        false,
      ),
    ).toBe(false);
  });

  it('does NOT close when the panel switches host A → B (fresh binding)', () => {
    expect(
      shouldCloseOnSelectionEdge(
        { panelNodeId: 'a', hostSelected: true },
        { panelNodeId: 'b', hostSelected: false },
        false,
      ),
    ).toBe(false);
  });

  it('stays open while the host remains selected (multi-select keeps it too)', () => {
    // Shift-clicking another node ADDS to the selection — the host is still
    // selected, so the panel stays.
    expect(shouldCloseOnSelectionEdge(snap({}), snap({}), false)).toBe(false);
  });

  it('leaves a vanished host to the node-gone guard (hostSelected null)', () => {
    expect(
      shouldCloseOnSelectionEdge(snap({}), snap({ hostSelected: null }), false),
    ).toBe(false);
  });

  it('does not re-fire without a fresh edge (already deselected)', () => {
    expect(
      shouldCloseOnSelectionEdge(
        snap({ hostSelected: false }),
        snap({ hostSelected: false }),
        false,
      ),
    ).toBe(false);
  });

  it('ignores the rising edge (deselected → selected)', () => {
    expect(
      shouldCloseOnSelectionEdge(
        snap({ hostSelected: false }),
        snap({}),
        false,
      ),
    ).toBe(false);
  });

  it('returns false when no panel is open', () => {
    expect(
      shouldCloseOnSelectionEdge(
        { panelNodeId: null, hostSelected: null },
        { panelNodeId: null, hostSelected: null },
        false,
      ),
    ).toBe(false);
  });
});
