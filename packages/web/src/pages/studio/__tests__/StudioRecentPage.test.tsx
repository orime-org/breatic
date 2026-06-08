// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';

import StudioRecentPage from '@web/pages/studio/StudioRecentPage';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// StudioRecentPage reads `onCreateProject` from the layout's Outlet context, so
// the test mounts it under a matching Outlet (as the router does at runtime).
function setup(onCreateProject: () => void = () => {}) {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={{ onCreateProject }} />}>
          <Route path='*' element={<StudioRecentPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('StudioRecentPage (cross-studio recent landing — rendered in the layout Outlet)', () => {
  it('renders the recent empty state (no cards) — real data arrives with a later /studio/recent slice', () => {
    const onCreate = vi.fn();
    setup(onCreate);
    // The feed is empty (no backend yet), so the page shows the empty state:
    // no card links, and the create-project CTA wired to the layout dialog.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    const btn = screen.getByRole('button', { name: /New project/i });
    fireEvent.click(btn);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
