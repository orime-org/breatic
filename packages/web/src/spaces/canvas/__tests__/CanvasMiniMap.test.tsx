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

  it('sits bottom-right with the zoom-popover gap (toolbar top edge 58px + sideOffset-8 twin = 66px margin)', () => {
    setup();
    const panel = screen.getByTestId('rf__minimap');
    expect(panel.className).toContain('bottom');
    expect(panel.className).toContain('right');
    expect(panel.className).toContain('mb-[66px]');
  });

  it('paints the floating-overlay surface with the overlay radius (zoom-popover twin, user-ratified)', () => {
    setup();
    const panel = screen.getByTestId('rf__minimap');
    for (const cls of ['border-border', 'shadow', 'rounded-overlay']) {
      expect(panel.className).toContain(cls);
    }
    expect(panel.className).not.toContain('rounded-md');
  });

  it('pins the viewport mask stroke to a screen-constant width (explicit maskStrokeWidth engages the library viewScale conversion)', () => {
    setup();
    const panel = screen.getByTestId('rf__minimap');
    // The library injects the CSS variable ONLY when maskStrokeWidth is a
    // number — its absence was the unstable-hairline bug (user report).
    expect(
      panel.style.getPropertyValue('--xy-minimap-mask-stroke-width-props'),
    ).not.toBe('');
  });
});
