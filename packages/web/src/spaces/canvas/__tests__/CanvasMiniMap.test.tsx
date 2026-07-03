// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

import { CanvasMiniMap } from '@web/spaces/canvas/CanvasMiniMap';

/**
 * Render the minimap inside the ReactFlow context it requires.
 *
 * Assertions target the library's real DOM (source-verified v12.10.2):
 * the outer Panel div carries `data-testid="rf__minimap"` (hardcoded — custom
 * testids do NOT pass through) plus our className; the accessible name
 * travels through an svg `<title>` via aria-labelledby, not an aria-label
 * attribute.
 * @returns The render result.
 */
function setup(): ReturnType<typeof render> {
  return render(
    <ReactFlowProvider>
      <CanvasMiniMap />
    </ReactFlowProvider>,
  );
}

describe('CanvasMiniMap (#1548)', () => {
  it('renders the ReactFlow minimap with an accessible i18n label (library default replaced)', () => {
    setup();
    expect(screen.getByTestId('rf__minimap')).toBeInTheDocument();
    const svg = screen.getByRole('img');
    // Accessible name comes from the svg <title>; our i18n label must
    // replace the library's default "Mini Map".
    expect(svg).toHaveAccessibleName();
    expect(svg).not.toHaveAccessibleName('Mini Map');
  });

  it('bottom edge aligns with the zoom popover (Radix anchors sideOffset-8 to the TRIGGER top at 53px, not the toolbar top - measured 61px)', () => {
    setup();
    const panel = screen.getByTestId('rf__minimap');
    expect(panel.className).toContain('bottom');
    expect(panel.className).toContain('right');
    expect(panel.className).toContain('mb-[61px]');
  });

  it('paints the floating-overlay surface with the overlay radius (zoom-popover twin, user-ratified)', () => {
    setup();
    const panel = screen.getByTestId('rf__minimap');
    for (const cls of ['border-border', 'shadow', 'rounded-overlay', 'overflow-hidden']) {
      expect(panel.className).toContain(cls);
    }
    expect(panel.className).not.toContain('rounded-md');
  });

  it('the viewport mask carries NO stroke - the mask contrast alone marks the viewport (user 2026-07-03)', () => {
    setup();
    const panel = screen.getByTestId('rf__minimap');
    // Explicit transparent (not an absent prop): the library default could
    // drift across upgrades, and an earlier hairline/active-border stroke
    // was ratified away entirely.
    expect(
      panel.style.getPropertyValue('--xy-minimap-mask-stroke-color-props'),
    ).toBe('transparent');
  });
});
