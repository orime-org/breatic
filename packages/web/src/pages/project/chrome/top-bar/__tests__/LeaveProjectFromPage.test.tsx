// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// The declarative router: the data router's fetcher hits the jsdom/undici
// AbortSignal mismatch (see src/app/__tests__/ProtectedRoute.test.tsx).
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';

vi.mock('@web/data/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api')>()),
  projectsApi: { leave: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { projectsApi } from '@web/data/api';
import { LeaveProjectFromPage } from '@web/pages/project/chrome/top-bar/LeaveProjectFromPage';

/**
 * The landing page, reporting the state the navigation carried.
 * @returns The probe.
 */
function Landing(): React.JSX.Element {
  const location = useLocation();
  const action = useNavigationType();
  return (
    <div data-testid='landing'>
      {action} {JSON.stringify(location.state)}
    </div>
  );
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/studio', '/project/p1']} initialIndex={1}>
        <Routes>
          <Route
            path='/project/:id'
            element={<LeaveProjectFromPage projectId='p1' projectName='Alley' open onOpenChange={() => {}} />}
          />
          <Route path='/studio' element={<Landing />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LeaveProjectFromPage', () => {
  it('asks first, then lands on the recent page in place of the project, marked as a leave', async () => {
    vi.mocked(projectsApi.leave).mockResolvedValue({ ok: true });
    setup();
    expect(screen.getByTestId('leave-project-dialog')).toHaveTextContent('Leave “Alley”?');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave' }));

    expect(await screen.findByTestId('landing')).toHaveTextContent('REPLACE {"leftProject":true}');
  });

  it('stays on the project when the leave is refused', async () => {
    vi.mocked(projectsApi.leave).mockRejectedValue(new Error('nope'));
    setup();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(projectsApi.leave).toHaveBeenCalledWith('p1'));
    expect(screen.queryByTestId('landing')).toBeNull();
  });
});
