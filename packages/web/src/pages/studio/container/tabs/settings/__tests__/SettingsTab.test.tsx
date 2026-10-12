// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the settings tab wires its two write surfaces together.
 *
 * The name and the slug are saved by the same mutation, so "a save is running"
 * is not the same question as "this rename is running", and the tab has to
 * hand each of them the right one. The broad answer holds Confirm back, or a
 * rename fires while another patch is still out and two ride the one mutation
 * at once. The narrow answer draws the spinner, which must not claim to be
 * renaming during a name save.
 *
 * The dialog itself closes on every path at any time, so neither flag can trap
 * anyone; getting the narrow one wrong costs an icon.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SettingsTab } from '@web/pages/studio/container/tabs/SettingsTab';
import { studiosApi } from '@web/data/api/studios';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@web/lib/use-debounce', () => ({
  useDebounce: <T,>(value: T): T => value,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    update: vi.fn(),
    uploadAvatar: vi.fn(),
    removeAvatar: vi.fn(),
    leave: vi.fn(),
    liveTransfer: vi.fn().mockResolvedValue(null),
    checkSlugAvailable: vi.fn().mockResolvedValue({ available: true }),
  },
}));

const STUDIO: StudioDetail = {
  id: 's1',
  slug: 'acme-studio',
  name: 'Acme',
  type: 'team',
  avatarUrl: null,
  bio: null,
  memberCount: 3,
  myStudioRole: 'admin',
};

/**
 * Render the whole settings tab.
 * @param studio - The studio shown (defaults to one without an avatar).
 * @returns The render result.
 */
function renderTab(studio: StudioDetail = STUDIO): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsTab studio={studio} members={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studiosApi.liveTransfer).mockResolvedValue(null);
  vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
    available: true,
  });
});

describe('SettingsTab — a save of one thing must not seize the other', () => {
  it('leaves the rename dialog dismissible while a NAME save is in flight', async () => {
    // Never resolves: the name's PATCH stays out for the whole case.
    vi.mocked(studiosApi.update).mockReturnValue(new Promise(() => {}));

    renderTab();
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(studiosApi.update).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('settings-slug-open'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('settings-slug-cancel'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('settings-slug-dialog'),
      ).not.toBeInTheDocument(),
    );
  });

  it('does not let a rename go out while another save is still out', async () => {
    // Both ride one mutation. Firing the second replaces the first on the
    // observer without stopping it, so two PATCHes run and both come back
    // into the same success handler — and both were addressed to the slug the
    // studio had when the pair started.
    vi.mocked(studiosApi.update).mockReturnValue(new Promise(() => {}));

    renderTab();
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(studiosApi.update).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('settings-slug-open'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('studio.container.settings.slug'), {
      target: { value: 'acme-renamed' },
    });
    // Wait for the check to ANSWER, not merely to be asked: while it is still
    // out the button is disabled for that reason instead, and the case would
    // pass without the gate it exists to test.
    await waitFor(() =>
      expect(
        screen.getByText('studio.container.dialog.slugAvailable'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled();
  });

  it('leaves the rename dialog dismissible while the RENAME itself is in flight', async () => {
    // The spinner says what is happening; leaving is the user's to decide.
    // Ant Design, Bootstrap, Chakra and Radix all keep these two apart, and
    // all of them default to dismissible.
    vi.mocked(studiosApi.update).mockReturnValue(new Promise(() => {}));

    renderTab();
    fireEvent.click(screen.getByTestId('settings-slug-open'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('studio.container.settings.slug'), {
      target: { value: 'acme-renamed' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId('settings-slug-confirm'));
    await waitFor(() => expect(studiosApi.update).toHaveBeenCalledTimes(1));

    const confirm = screen.getByTestId('settings-slug-confirm');
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm.querySelector('.animate-spin')).not.toBeNull();

    fireEvent.click(screen.getByTestId('settings-slug-cancel'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('settings-slug-dialog'),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('SettingsTab — picking an avatar (inner#1367 A4)', () => {
  const RIFF_WEBP = [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];

  // jsdom has no object URLs; the crop dialog asks for one to show the file.
  beforeEach(() => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock/0'), revokeObjectURL: vi.fn() });
  });

  /**
   * Pick a file in the avatar input.
   * @param bytes - The file's first bytes.
   * @param name - Its name.
   * @param type - The type it claims.
   */
  function pick(bytes: number[], name: string, type: string): void {
    const file = new File([new Uint8Array([...bytes, ...new Array<number>(64).fill(0)])], name, { type });
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [file] } });
  }

  it('turns away a WebP named and typed as a JPEG, before the crop', async () => {
    const { toast } = await import('@web/lib/toast');
    renderTab();

    pick(RIFF_WEBP, 'photo.jpg', 'image/jpeg');

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('studio.container.imageError.unsupported_type'),
    );
    expect(screen.queryByTestId('image-crop-dialog')).toBeNull();
  });

  it('opens the crop for a JPEG', async () => {
    const { toast } = await import('@web/lib/toast');
    renderTab();

    pick(JPEG, 'photo.jpg', 'image/jpeg');

    await waitFor(() => expect(screen.getByTestId('image-crop-dialog')).toBeTruthy());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('SettingsTab — removing the avatar (inner#1374)', () => {
  /**
   * Open the remove confirmation on a studio that has an avatar and press its
   * confirm button, with the request held open.
   * @param succeeds - Whether the held request resolves or rejects.
   * @returns The confirm button and the function that answers the request.
   */
  async function removeHeld(succeeds: boolean): Promise<{ confirm: HTMLElement; settle: () => void }> {
    let settle: () => void = () => {};
    vi.mocked(studiosApi.removeAvatar).mockReturnValue(
      new Promise((resolve, reject) => {
        settle = succeeds
          ? () =>
            resolve({ ...STUDIO, avatarUrl: null } as unknown as Awaited<
              ReturnType<typeof studiosApi.removeAvatar>
            >)
          : () => reject(new Error('nope'));
      }),
    );
    renderTab({ ...STUDIO, avatarUrl: 'https://cdn.example/a.webp' });
    fireEvent.click(screen.getByTestId('avatar-remove-open'));
    const confirm = await screen.findByTestId('avatar-remove-confirm');
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('avatar-remove-dialog')).toBeInTheDocument();
    return { confirm, settle };
  }

  it('keeps the confirmation open with a busy Remove until the avatar is gone, then closes it', async () => {
    const { settle } = await removeHeld(true);
    settle();
    await waitFor(() =>
      expect(screen.queryByTestId('avatar-remove-dialog')).toBeNull(),
    );
  });

  it('keeps the confirmation open with Remove pressable again when the removal fails', async () => {
    const { confirm, settle } = await removeHeld(false);
    settle();
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('avatar-remove-dialog')).toBeInTheDocument();
  });
});
