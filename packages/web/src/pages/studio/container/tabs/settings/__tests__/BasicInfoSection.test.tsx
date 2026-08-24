// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the settings form will and will not let through.
 *
 * The slug used to be a third field here and is now in the danger zone, so
 * everything about it — the availability check, the emptiness guard, the
 * confirmation — moved to `ChangeSlugSection.test.tsx` with it. What stays is
 * the pair of fields that are freely reversible, plus a guard that the slug
 * really is gone from here.
 */

import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { BasicInfoSection } from '@web/pages/studio/container/tabs/settings/BasicInfoSection';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
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
 * Render the section.
 * @param props - Overrides for the section's props.
 * @param props.canEdit - Whether the fields are editable.
 * @param props.onSave - The save handler.
 * @returns The render result.
 */
function renderSection(props: {
  canEdit?: boolean;
  onSave?: (patch: unknown) => void;
} = {}): ReturnType<typeof render> {
  return render(
    <BasicInfoSection
      studio={STUDIO}
      canEdit={props.canEdit ?? true}
      saving={false}
      onSave={props.onSave ?? vi.fn()}
    />,
  );
}

describe('BasicInfoSection — the submit gate', () => {
  it('stays disabled while nothing has changed', () => {
    renderSection();
    expect(screen.getByTestId('settings-save')).toBeDisabled();
  });

  it('enables once a field actually changes', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeEnabled(),
    );
  });

  it('refuses an emptied Name', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: '   ' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('settings-save')).toBeDisabled(),
    );
  });

  it('sends only what changed, and saves without a confirmation', () => {
    const onSave = vi.fn();
    renderSection({ onSave });
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(onSave).toHaveBeenCalledWith({ name: 'Acme Inc' });
  });
});

describe('BasicInfoSection — what is no longer here', () => {
  it('does not offer the Slug beside the name and description', () => {
    // Editing it releases the old address to anyone and 404s every link that
    // points at this studio, which is not something to sit under the same
    // Save button as the description.
    renderSection();
    expect(
      screen.queryByLabelText('studio.container.settings.slug'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('settings-slug-dialog'),
    ).not.toBeInTheDocument();
  });
});

describe('BasicInfoSection — a non-admin', () => {
  it('sees the values but gets no save button', () => {
    renderSection({ canEdit: false });
    expect(screen.getByTestId('settings-name')).toHaveValue('Acme');
    expect(screen.queryByTestId('settings-save')).not.toBeInTheDocument();
  });

  it('gets both fields disabled', () => {
    renderSection({ canEdit: false });
    expect(screen.getByTestId('settings-name')).toBeDisabled();
    expect(screen.getByTestId('settings-bio')).toBeDisabled();
  });
});
