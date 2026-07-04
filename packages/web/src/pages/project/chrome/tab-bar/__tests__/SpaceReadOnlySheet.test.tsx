// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SpaceReadOnlySheet } from '@web/pages/project/chrome/tab-bar/SpaceReadOnlySheet';
import type { ProjectSpace } from '@web/data/yjs/project-meta';

const SPACE: ProjectSpace = {
  id: 'sp-1',
  name: 'Reel',
  type: 'canvas',
  locked: false,
};

describe('SpaceReadOnlySheet', () => {
  it('opens as a modal sheet with a backdrop overlay, like dialogs', () => {
    // User decision 2026-07-04: chrome sheets (SpaceDrawer / messages /
    // read-only peek) show the same backdrop as dialogs. The peek sheet
    // is the third member of the right-floating family — it must not
    // split from its siblings (member view with backdrop, viewer view
    // without would be an inconsistent state).
    render(<SpaceReadOnlySheet open space={SPACE} onClose={vi.fn()} />);
    expect(screen.getByTestId('space-read-only-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('sheet-overlay')).toBeInTheDocument();
  });
});
