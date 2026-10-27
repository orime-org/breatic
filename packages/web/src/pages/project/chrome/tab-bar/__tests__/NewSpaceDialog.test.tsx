// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewSpaceDialog } from '@web/pages/project/chrome/tab-bar/NewSpaceDialog';
import { useUIStore } from '@web/stores/ui';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';

afterEach(() => {
  cleanup();
  useUIStore.getState().setActiveOverlayId(null);
});

describe('NewSpaceDialog scene type selection', () => {
  it('submits 3D when the user selects the 3D type and creates a Space', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewSpaceDialog trigger={<button>New Space</button>} onCreate={onCreate} />);
    await user.click(screen.getByRole('button', { name: 'New Space' }));
    await user.type(screen.getByLabelText('Name'), 'Scene');
    await user.click(screen.getByRole('radio', { name: '3D' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith('3d', 'Scene');
  });
});
