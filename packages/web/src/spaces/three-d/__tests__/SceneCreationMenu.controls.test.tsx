// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectRole } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';
import { SceneCreationMenu } from '@web/spaces/three-d/SceneCreationMenu';
import { PROJECT, RAW_CATALOG, SPACE } from '@web/spaces/three-d/__tests__/scene-generate-fixtures';

const api = vi.hoisted(() => ({ get: vi.fn(async (url: string) => {
  if (url === '/models') return RAW_CATALOG;
  throw new Error(`unexpected GET ${url}`);
}) }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: api.get,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Render the 3D left rail.
 * @returns The render result.
 */
function renderMenu(canEdit = true, onImport = vi.fn()): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <SceneCreationMenu projectId={PROJECT} spaceId={SPACE} canEdit={canEdit} onAdd={vi.fn()} onImport={onImport} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * Render the 3D left rail for a member of the given project role.
 * @param root0 - The role and the scene's readiness.
 * @param root0.myRole - The member's project role.
 * @param root0.canEdit - Whether the scene is ready for shared edits.
 * @returns The add and import handlers.
 */
function renderRail({ myRole, canEdit }: { myRole: ProjectRole; canEdit: boolean }): { onAdd: ReturnType<typeof vi.fn>; onImport: ReturnType<typeof vi.fn> } {
  const onAdd = vi.fn();
  const onImport = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <SceneCreationMenu projectId={PROJECT} spaceId={SPACE} myRole={myRole} canEdit={canEdit} onAdd={onAdd} onImport={onImport} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onAdd, onImport };
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

describe('SceneCreationMenu entries by project role and scene readiness (inner#1691 design 7.1)', () => {
  it('shows a read-only member Add, Import model and AI generation as present but unmet, a click saying why', async () => {
    const user = userEvent.setup();
    const { onAdd, onImport } = renderRail({ myRole: 'viewer', canEdit: false });
    const rail = screen.getByTestId('scene-left-menu');
    const entries = ['Add', 'Import model', 'AI generation'].map((name) => within(rail).getByRole('button', { name }));
    for (const entry of entries) {
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry).not.toBeDisabled();
    }
    for (const entry of entries) await user.click(entry);

    const said = (toast.warning as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(said).toHaveLength(3);
    for (const message of said) expect(message).toMatch(/^(?!spaces\.)\S/);
    expect(screen.queryAllByRole('menuitem')).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('keeps Add and Import model unavailable for an editor while the scene is not ready, with AI generation opening the generation dialog', async () => {
    const user = userEvent.setup();
    renderRail({ myRole: 'editor', canEdit: false });
    const rail = screen.getByTestId('scene-left-menu');
    for (const name of ['Add', 'Import model']) {
      const entry = within(rail).getByRole('button', { name });
      expect(entry).toBeDisabled();
      expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    }
    const generate = within(rail).getByRole('button', { name: 'AI generation' });
    expect(generate).toBeEnabled();
    expect(generate).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(generate);
    const dialog = await screen.findByRole('dialog', { name: 'AI generation' });
    expect(await within(dialog).findByTestId('scene-generate-mode-t23d')).toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
