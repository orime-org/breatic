// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SceneImagePickerDialog } from '@web/spaces/three-d/SceneImagePickerDialog';
import { PROJECT, projectImage } from '@web/spaces/three-d/__tests__/scene-generate-fixtures';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: api.get,
}));

const ASSETS = `/projects/${PROJECT}/assets`;

/**
 * Render the picker open.
 * @returns Its handlers.
 */
function renderPicker(): { onPick: ReturnType<typeof vi.fn>; onPickFile: ReturnType<typeof vi.fn>; onOpenChange: ReturnType<typeof vi.fn> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPick = vi.fn();
  const onPickFile = vi.fn();
  const onOpenChange = vi.fn();
  render(<QueryClientProvider client={client}><TooltipProvider>
    <SceneImagePickerDialog projectId={PROJECT} open onOpenChange={onOpenChange} onPick={onPick} onPickFile={onPickFile} />
  </TooltipProvider></QueryClientProvider>);
  return { onPick, onPickFile, onOpenChange };
}

/**
 * The asset ids the Project tab lists, in order.
 * @returns The ids.
 */
function listed(): string[] {
  return screen.queryAllByTestId(/^scene-image-picker-item-/).map((element) => element.dataset.testid!.replace('scene-image-picker-item-', ''));
}

beforeEach(() => {
  api.get.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SceneImagePickerDialog (inner#1691 design 7.2)', () => {
  it('lists the Project\'s images a page at a time, asking for images only', async () => {
    api.get
      .mockResolvedValueOnce({ items: [projectImage('a1'), projectImage('a2')], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ items: [projectImage('a3')], nextCursor: null });
    const user = userEvent.setup();
    renderPicker();
    await waitFor(() => expect(listed()).toEqual(['a1', 'a2']));
    expect(api.get).toHaveBeenCalledWith(ASSETS, expect.objectContaining({ params: { kind: 'image', cursor: undefined } }));

    await user.click(screen.getByTestId('scene-image-picker-more'));
    await waitFor(() => expect(listed()).toEqual(['a1', 'a2', 'a3']));
    expect(api.get).toHaveBeenLastCalledWith(ASSETS, expect.objectContaining({ params: { kind: 'image', cursor: 'cursor-2' } }));
    expect(screen.queryByTestId('scene-image-picker-more')).toBeNull();
  });

  it('hands the chosen image over by its asset, address and name, and closes', async () => {
    api.get.mockResolvedValue({ items: [projectImage('a1', 'lamp.png')], nextCursor: null });
    const user = userEvent.setup();
    const { onPick, onOpenChange } = renderPicker();
    await user.click(await screen.findByTestId('scene-image-picker-item-a1'));
    expect(onPick).toHaveBeenCalledWith({ assetId: 'a1', url: 'https://cdn.test/a1.png', displayName: 'lamp.png' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the list loading until the first page arrives', async () => {
    const page = Promise.withResolvers<unknown>();
    api.get.mockReturnValue(page.promise);
    renderPicker();
    expect(await screen.findByTestId('scene-image-picker-loading')).toBeInTheDocument();
    expect(listed()).toEqual([]);
    page.resolve({ items: [projectImage('a1')], nextCursor: null });
    await waitFor(() => expect(listed()).toEqual(['a1']));
    expect(screen.queryByTestId('scene-image-picker-loading')).toBeNull();
  });

  it('says so when the Project has no images', async () => {
    api.get.mockResolvedValue({ items: [], nextCursor: null });
    renderPicker();
    expect(await screen.findByTestId('scene-image-picker-empty')).toBeInTheDocument();
    expect(listed()).toEqual([]);
  });

  it('offers a retry when the list fails to load, and lists the images once it does', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [projectImage('a1')], nextCursor: null });
    const user = userEvent.setup();
    renderPicker();
    expect(await screen.findByTestId('scene-image-picker-error')).toBeInTheDocument();
    await user.click(screen.getByTestId('scene-image-picker-retry'));
    await waitFor(() => expect(listed()).toEqual(['a1']));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('scene-image-picker-error')).toBeNull();
  });

  it('takes a file from the computer on the Local tab, and closes', async () => {
    api.get.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    const { onPickFile, onOpenChange } = renderPicker();
    await user.click(screen.getByTestId('scene-image-picker-local'));
    const file = new File(['png'], 'chair.png', { type: 'image/png' });
    await user.upload(screen.getByTestId('scene-image-picker-file-input'), file);
    expect(onPickFile).toHaveBeenCalledWith(file);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
