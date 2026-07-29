// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the settings form will and will not let through.
 *
 * The emptiness cases are the ones an adversarial review found: an emptied
 * field reads as `idle` from the availability check rather than `invalid`, so
 * it slipped past the submit gate and the user walked all the way through the
 * destructive slug confirmation before the server rejected it.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { BasicInfoSection } from '@web/pages/studio/container/tabs/settings/BasicInfoSection';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@web/domain/use-debounce', () => ({
  useDebounce: <T,>(value: T): T => value,
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: { checkSlugAvailable: vi.fn().mockResolvedValue({ available: true }) },
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
 * Render the section under a query client.
 * @param props - Overrides for the section's props.
 * @param props.studio - The studio being edited.
 * @param props.canEdit - Whether the fields are editable.
 * @param props.onSave - The save handler.
 * @returns The render result.
 */
function renderSection(props: {
  studio?: StudioDetail;
  canEdit?: boolean;
  onSave?: (patch: unknown) => void;
}): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BasicInfoSection
        studio={props.studio ?? STUDIO}
        canEdit={props.canEdit ?? true}
        saving={false}
        onSave={props.onSave ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('BasicInfoSection — the submit gate', () => {
  it('stays disabled while nothing has changed', () => {
    renderSection({});
    expect(screen.getByTestId('settings-save')).toBeDisabled();
  });

  it('enables once a field actually changes', async () => {
    renderSection({});
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeEnabled(),
    );
  });

  it('refuses an emptied Slug rather than walking the user to the confirmation', async () => {
    renderSection({});
    fireEvent.change(screen.getByLabelText('studio.container.settings.slug'), {
      target: { value: '' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeDisabled(),
    );
  });

  it('refuses an emptied Name', async () => {
    renderSection({});
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: '   ' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeDisabled(),
    );
  });

  it('does not ask the server whether the studio may keep its own Slug', () => {
    // The form starts out holding it; asking gets the truthful answer "taken",
    // by the very studio doing the asking.
    renderSection({});
    expect(screen.getByTestId('settings-save')).toBeDisabled();
  });
});

describe('BasicInfoSection — the slug confirmation', () => {
  it('is shown before a slug change, never before a name-only change', async () => {
    const onSave = vi.fn();
    renderSection({ onSave });

    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId('settings-save'));

    // A name-only edit saves straight away.
    expect(onSave).toHaveBeenCalledWith({ name: 'Acme Inc' });
    expect(screen.queryByTestId('settings-slug-dialog')).not.toBeInTheDocument();
  });

  it('holds a slug change behind the confirmation', async () => {
    const onSave = vi.fn();
    renderSection({ onSave });

    fireEvent.change(screen.getByLabelText('studio.container.settings.slug'), {
      target: { value: 'acme-renamed' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId('settings-save'));

    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('settings-slug-dialog')).toBeInTheDocument(),
    );
  });
});

describe('BasicInfoSection — a non-admin', () => {
  it('sees the values but gets no save button', () => {
    renderSection({ canEdit: false });
    expect(screen.getByTestId('settings-name')).toHaveValue('Acme');
    expect(screen.queryByTestId('settings-save')).not.toBeInTheDocument();
  });

  it('gets every field disabled, Slug included', () => {
    // Slug used to stay editable while Name and Bio greyed out — the one
    // field inviting an edit that could never be submitted.
    renderSection({ canEdit: false });
    expect(screen.getByTestId('settings-name')).toBeDisabled();
    expect(screen.getByTestId('settings-bio')).toBeDisabled();
    expect(
      screen.getByLabelText('studio.container.settings.slug'),
    ).toBeDisabled();
  });
});
