// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import StudioContainerPage from '@web/pages/studio/container/StudioContainerPage';
import { NewItemDialog } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { ProjectsTab } from '@web/pages/studio/container/tabs/ProjectsTab';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import type { StudioDetail } from '@breatic/shared';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { get: vi.fn(), listUserStudios: vi.fn() },
}));
import { studiosApi } from '@web/data/api/studios';

const TEAM_DETAIL: StudioDetail = {
  id: 's-acme',
  slug: 'acme-studio',
  name: 'Acme Studio',
  type: 'team',
  memberCount: 4,
  myStudioRole: 'admin',
};

beforeEach(() => {
  vi.mocked(studiosApi.get).mockResolvedValue(TEAM_DETAIL);
  vi.mocked(studiosApi.listUserStudios).mockResolvedValue([
    {
      id: 's-acme',
      slug: 'acme-studio',
      name: 'Acme Studio',
      type: 'team',
      memberCount: 4,
      myStudioRole: 'guest',
    },
  ]);
});

// ── invariant 5: StrictMode-safe (no double-mount duplication / leak) ───────
describe('studio container — invariant 5 (StrictMode-safe)', () => {
  it('renders the container exactly once under React.StrictMode double-invoke', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/studio/acme-studio']}>
            <Routes>
              <Route path='/studio/:slug' element={<StudioContainerPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
    // If a component duplicated DOM under the double render, the tab count
    // would multiply; exactly 6 tabs (once the shell query resolves) proves
    // render idempotence. The top bar moved to the layout route, so the
    // standalone container no longer renders a banner. 6 tabs = team studio
    // with Works added at the 3rd position (spec §6.1).
    expect(await screen.findAllByRole('tab')).toHaveLength(6);
  });
});

// ── invariant 6: a11y on the new interactive surfaces ──────────────────────
describe('studio container — invariant 6 (a11y)', () => {
  it('the create dialog has no a11y violations when open', async () => {
    const { baseElement } = render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} />,
    );
    // The dialog renders in a portal under document.body (baseElement).
    await expectNoA11yViolations(baseElement);
  });
});

// ── empty state (§3.13) ────────────────────────────────────────────────────
describe('studio tabs — empty state (spec §3.13)', () => {
  it('shows the empty hint and the new-project card when there are no projects', () => {
    render(
      <MemoryRouter>
        <ProjectsTab projects={[]} studioRole='admin' />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New project/ }),
    ).toBeInTheDocument();
  });
});
