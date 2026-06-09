// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import StudioLayout from '@web/pages/studio/shell/StudioLayout';
import { TooltipProvider } from '@web/components/ui/tooltip';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { listUserStudios: vi.fn() },
}));
// The top bar's shared BellMenu fetches the inbox on mount — stub it so the
// layout structure tests stay deterministic (no real network, no late state
// settle after the assertion).
vi.mock('@web/data/api/notifications', () => ({
  notificationsApi: { list: vi.fn() },
}));
import { studiosApi } from '@web/data/api/studios';
import { notificationsApi } from '@web/data/api/notifications';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studiosApi.listUserStudios).mockResolvedValue([]);
  vi.mocked(notificationsApi.list).mockResolvedValue({ data: [] });
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/studio']}>
          <Routes>
            <Route path='/studio' element={<StudioLayout />}>
              <Route
                index
                element={<div data-testid='outlet-child'>child</div>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('StudioLayout — shell structure (top bar full-width on top, rail below)', () => {
  it('stacks the full-width top bar above the rail+content row (flex-col), not the rail beside the bar', async () => {
    const { container } = setup();
    // Flush the rail + BellMenu inbox queries so their state updates settle
    // inside act() before the structure assertions.
    await screen.findByTestId('outlet-child');
    const root = container.firstElementChild as HTMLElement;

    // GitHub/Linear layout per the dir3-neutral mock (.topbar is full-width
    // and sits ABOVE everything): the screen container is a VERTICAL stack
    // (flex-col), not a horizontal flex with the rail as the first
    // full-height column squeezing the top bar into the right.
    expect(root.className).toContain('flex-col');

    const banner = screen.getByRole('banner');
    const nav = screen.getByRole('navigation');

    // The top bar (banner) is a DIRECT child of the screen container, so it
    // spans the full width; the rail (nav) lives in the row BELOW it (not a
    // direct child of the root).
    expect(banner.parentElement).toBe(root);
    expect(nav.parentElement).not.toBe(root);

    // Document order: top bar first, rail after it.
    expect(
      banner.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the routed child in the content area next to the rail', async () => {
    setup();
    expect(await screen.findByTestId('outlet-child')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});
