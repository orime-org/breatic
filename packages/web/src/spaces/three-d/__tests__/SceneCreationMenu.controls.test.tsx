// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SceneCreationMenu } from '@web/spaces/three-d/SceneCreationMenu';

/**
 * Render the 3D left rail.
 * @returns The render result.
 */
function renderMenu(canEdit = true, onImport = vi.fn()): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <SceneCreationMenu canEdit={canEdit} onAdd={vi.fn()} onImport={onImport} />
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

  it('puts Import model second on the rail, between Add and AI generation, and opens the import from it', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    renderMenu(true, onImport);
    const rail = screen.getByTestId('scene-left-menu');
    const names = within(rail).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(names.slice(0, 3)).toEqual(['Add', 'Import model', 'AI generation']);
    await user.click(within(rail).getByRole('button', { name: 'Import model' }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it('makes Import model unavailable while the Space is read-only', () => {
    renderMenu(false);
    expect(within(screen.getByTestId('scene-left-menu')).getByRole('button', { name: 'Import model' })).toBeDisabled();
  });

  it('keeps only the built-in objects in the Add menu', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Add block', 'Add figure']);
  });
});
