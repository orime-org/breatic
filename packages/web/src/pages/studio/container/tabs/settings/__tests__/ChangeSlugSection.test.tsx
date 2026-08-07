// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The danger zone's slug entry: a button, and a dialog that holds the input.
 *
 * The gate is written as "only when the check says available" rather than
 * "unless the check says invalid", because an emptied field reports neither —
 * it reports idle. The version of this gate that lived in the basic-info form
 * had to be corrected for exactly that, and the correction travels with the
 * feature.
 *
 * Confirming does not close the dialog. On success the whole tab unmounts
 * anyway, since the address it is standing on has just stopped existing; on
 * failure the dialog is still there holding what the user typed, instead of
 * making them type it again.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ChangeSlugSection } from '@web/pages/studio/container/tabs/settings/ChangeSlugSection';
import { studiosApi } from '@web/data/api/studios';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

// Interpolation values are rendered alongside the key, because one of the
// cases below is about what gets substituted into the address sentence.
vi.mock('@web/i18n/use-translation', () => ({
  useTranslation:
    () =>
      (key: string, params?: Record<string, unknown>): string =>
        params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
vi.mock('@web/domain/use-debounce', () => ({
  useDebounce: <T,>(value: T): T => value,
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
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

const SLUG_LABEL = 'studio.container.settings.slug';

/**
 * Render the section.
 * @param props - Overrides for the section's props.
 * @param props.saving - Whether a save is in flight.
 * @param props.onSave - The save handler.
 * @returns The render result.
 */
function renderSection(props: {
  saving?: boolean;
  onSave?: (patch: unknown) => void;
} = {}): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChangeSlugSection
        studio={STUDIO}
        saving={props.saving ?? false}
        onSave={props.onSave ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/**
 * Open the dialog and hand back its slug input.
 * @returns The slug input element.
 */
async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('settings-slug-open'));
  await waitFor(() =>
    expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
  );
  return screen.getByLabelText(SLUG_LABEL);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
    available: true,
  });
});

describe('ChangeSlugSection — the entry point', () => {
  it('is a button, with the input out of reach until it is pressed', () => {
    renderSection();
    expect(screen.getByTestId('settings-slug-open')).toBeInTheDocument();
    expect(screen.queryByLabelText(SLUG_LABEL)).not.toBeInTheDocument();
  });

  it('opens onto the studio’s current slug', async () => {
    renderSection();
    const input = await openDialog();
    expect(input).toHaveValue(STUDIO.slug);
  });

  it('does not claim the address changes to the address it already has', async () => {
    // The sentence names both ends, and on open both ends are the same slug —
    // "the address changes from acme-studio to acme-studio" is the first thing
    // the user reads. The destination stays a placeholder until there is one.
    renderSection();
    await openDialog();
    const body = screen.getByTestId('settings-slug-body');
    expect(body).toHaveTextContent(`"oldSlug":"${STUDIO.slug}"`);
    expect(body).not.toHaveTextContent(`"newSlug":"${STUDIO.slug}"`);
  });

  it('names the destination once there is one', async () => {
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-body')).toHaveTextContent(
        '"newSlug":"acme-renamed"',
      ),
    );
  });
});

describe('ChangeSlugSection — the confirm gate', () => {
  it('refuses the slug the studio already holds', async () => {
    renderSection();
    await openDialog();
    expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled();
  });

  it('refuses an emptied field, which reports idle rather than invalid', async () => {
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled(),
    );
  });

  it('never asks the server whether the studio may keep its own slug', async () => {
    // The dialog opens holding it, and asking gets the truthful answer
    // "taken" — by the very studio doing the asking. Assert the request never
    // goes out, and that editing away and back leaves no taken error behind:
    // checking the confirm button instead would pass either way, since it is
    // disabled while the value is unchanged regardless.
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
      available: false,
      reason: 'taken',
    });
    renderSection();
    const input = await openDialog();

    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(studiosApi.checkSlugAvailable).toHaveBeenCalledWith(
        'acme-renamed',
        expect.anything(),
      ),
    );
    fireEvent.change(input, { target: { value: STUDIO.slug } });

    await waitFor(() =>
      expect(
        screen.queryByText('studio.container.dialog.slugTaken'),
      ).not.toBeInTheDocument(),
    );
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalledWith(
      STUDIO.slug,
      expect.anything(),
    );
  });

  it('refuses a slug somebody else holds', async () => {
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
      available: false,
      reason: 'taken',
    });
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(
        screen.getByText('studio.container.dialog.slugTaken'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled();
  });

  it('lets a free, well-formed slug through, and sends only the slug', async () => {
    const onSave = vi.fn();
    renderSection({ onSave });
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );

    fireEvent.click(screen.getByTestId('settings-slug-confirm'));
    expect(onSave).toHaveBeenCalledWith({ slug: 'acme-renamed' });
  });

  it('stays shut while a save is already in flight', async () => {
    renderSection({ saving: true });
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeDisabled(),
    );
  });
});

describe('ChangeSlugSection — after confirming', () => {
  it('keeps the dialog and the typed value, so a failure costs nothing', async () => {
    // Success unmounts this whole tab — the address it is standing on has just
    // been released. So the only state in which the dialog is still around
    // after a confirm is a failed one, and closing it there would throw away
    // what the user typed.
    const onSave = vi.fn();
    renderSection({ onSave });
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-confirm')).toBeEnabled(),
    );

    fireEvent.click(screen.getByTestId('settings-slug-confirm'));

    expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(SLUG_LABEL)).toHaveValue('acme-renamed');
  });

  it('forgets the draft when the dialog is dismissed instead', async () => {
    renderSection();
    const input = await openDialog();
    fireEvent.change(input, { target: { value: 'acme-renamed' } });
    fireEvent.click(screen.getByTestId('settings-slug-cancel'));

    await waitFor(() =>
      expect(
        screen.queryByTestId('settings-slug-dialog'),
      ).not.toBeInTheDocument(),
    );
    const reopened = await openDialog();
    expect(reopened).toHaveValue(STUDIO.slug);
  });
});
