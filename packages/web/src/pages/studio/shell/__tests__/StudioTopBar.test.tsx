// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { StudioTopBar } from '@web/pages/studio/shell/StudioTopBar';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// The top bar embeds the shared BellMenu, which fetches the inbox on mount —
// stub it so the structure tests stay deterministic (no real network).
vi.mock('@web/data/api/notifications', () => ({
  notificationsApi: { list: vi.fn() },
}));
import { notificationsApi } from '@web/data/api/notifications';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notificationsApi.list).mockResolvedValue([]);
});

function setup() {
  // The top bar now embeds the shared notifications `BellMenu`, which uses
  // React Query + a Radix tooltip — provide both contexts.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter>
          <StudioTopBar />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Await the BellMenu inbox query settling so React state updates run in act. */
async function flushInbox(): Promise<void> {
  await screen.findByTestId('bell-trigger');
}

describe('StudioTopBar', () => {
  it('renders a banner landmark', async () => {
    setup();
    await flushInbox();
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('wires the same shared language + theme switchers as the project top bar', async () => {
    setup();
    await flushInbox();
    // Studio renders the shared `features/preferences` switchers (identical
    // look + behavior to project), not bespoke studio-only buttons — so the
    // project testids are present here too.
    expect(screen.getByTestId('lang-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders the brand (real logo mark + Breatic) linking to /studio, with no switcher or search', async () => {
    setup();
    await flushInbox();
    // The studio switcher moved to the persistent rail and search is dropped
    // this version, so the top bar is just brand + tools.
    const home = screen.getByRole('link', { name: 'Studio home' });
    expect(home).toHaveAttribute('href', '/studio');
    expect(screen.getByText('Breatic')).toBeInTheDocument();
    // The brand uses the shared REAL logo mark (the same `BrandMark` atom the
    // project top bar renders), not the old "b" placeholder square.
    expect(screen.getByTestId('top-bar-logo')).toBeInTheDocument();
    expect(screen.queryByText('b')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await flushInbox();
    await expectNoA11yViolations(container);
  });
});
