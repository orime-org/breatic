// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SceneCreationMenu } from '@web/spaces/three-d/SceneCreationMenu';

/**
 * Render the 3D left rail.
 * @returns The render result.
 */
function renderMenu(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <SceneCreationMenu canEdit onAdd={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('SceneCreationMenu controls entry', () => {
  it('names the bottom rail button Controls and draws a keyboard, leaving the question mark to the top bar', () => {
    renderMenu();
    const rail = screen.getByTestId('scene-left-menu');
    const controls = within(rail).getByRole('button', { name: 'Controls' });
    expect(controls.querySelector('svg.lucide-keyboard')).not.toBeNull();
    expect(rail.querySelector('svg.lucide-circle-question-mark, svg.lucide-help-circle')).toBeNull();
    expect(within(rail).queryByRole('button', { name: 'Help' })).toBeNull();
  });

  it('opens the 3D controls description under the same name', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Controls' }));
    const dialog = await screen.findByRole('dialog', { name: 'Controls' });
    expect(dialog).toHaveTextContent('Drag empty space to orbit');
  });
});
