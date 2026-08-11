// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { RailFooter } from '@web/pages/studio/rail/RailFooter';
import { StudioRail } from '@web/pages/studio/rail/StudioRail';
import { StudioRailDrawer } from '@web/pages/studio/rail/StudioRailDrawer';
import { RAIL_ROW_TOP } from '@web/pages/studio/rail/rail-row';

// Creating a Studio is not the same kind of act as creating something inside
// the Studio you are already in, which is why it sits at the foot of the rail
// rather than beside the other two create actions. This behaviour moved here
// from RailCreateActions; the assertion moved with it rather than being lost
// in the split.
describe('RailFooter (the rail’s pinned foot)', () => {
  it('fires onCreateStudio when clicked', () => {
    const onCreateStudio = vi.fn();
    render(<RailFooter onCreateStudio={onCreateStudio} />);

    fireEvent.click(screen.getByRole('button', { name: 'New Studio' }));
    expect(onCreateStudio).toHaveBeenCalledTimes(1);
  });

  it('is enabled', () => {
    render(<RailFooter onCreateStudio={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'New Studio' })).toBeEnabled();
  });

  it('is a top-level rail row, from the one definition the other three use', () => {
    render(<RailFooter onCreateStudio={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'New Studio' }).className,
    ).toContain(RAIL_ROW_TOP);
  });

  it('fills its container without needing one to stretch it', () => {
    // A <button> sizes to its content whatever its display, so the three rows
    // above only fill the rail because their parent is a flex column. This one
    // sits in the footer, where nothing stretches it — the row has to carry its
    // own width or it comes out half as wide as the rows it should match.
    render(<RailFooter onCreateStudio={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'New Studio' }).className,
    ).toMatch(/(^|\s)w-full(\s|$)/);
  });

  it('carries its own rule and padding, so a host cannot draw a second version', () => {
    const { container } = render(<RailFooter onCreateStudio={vi.fn()} />);
    expect(container.firstElementChild?.className).toContain('border-t');
    expect(container.firstElementChild?.className).toContain('shrink-0');
  });

  it('is pinned by a scroller that will give way', () => {
    // `shrink-0` only pins the foot if something above it shrinks, and a flex
    // child refuses to go below its content without `min-h-0` — so a long
    // studio list would push the foot out of view. The two halves of that fact
    // sit in different components, and asserting one without the other leaves
    // the pinning resting on a class no test names.
    const railTree = render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    const railScroller = railTree.container.querySelector(
      '[data-radix-scroll-area-viewport]',
    )?.parentElement;
    expect(railScroller?.className).toMatch(/(^|\s)min-h-0(\s|$)/);
    expect(railScroller?.className).toMatch(/(^|\s)flex-1(\s|$)/);
  });

  it('renders identically in both hosts, down to the markup', async () => {
    // The two hosts used to write this segment out separately, and the two
    // copies came out byte-identical — the state every drift in this rail so
    // far has started from. Comparing the rendered foot catches a change made
    // to one host and not the other, which asserting `border-t` twice cannot.
    const railTree = render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    // Found by the rule it draws, not by position: the vendor Sheet appends its
    // own close button after the drawer's children, so "last child" means two
    // different things in the two hosts.
    const railFoot =
      railTree.container.querySelector('nav > .border-t')?.outerHTML;
    railTree.unmount();

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioRailDrawer
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawerFoot = screen
      .getByTestId('studio-rail-drawer')
      .querySelector(':scope > .border-t')?.outerHTML;

    expect(railFoot).toBeTruthy();
    expect(drawerFoot).toBe(railFoot);
  });
});
