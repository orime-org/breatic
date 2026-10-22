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
import { render, screen, fireEvent } from '@testing-library/react';

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
      savingDetails={false}
      onSave={props.onSave ?? vi.fn()}
    />,
  );
}

describe('BasicInfoSection — the submit gate', () => {
  it('keeps the browser from offering past entries in the name field', () => {
    renderSection();
    expect(screen.getByTestId('settings-name')).toHaveAttribute(
      'autocomplete',
      'off',
    );
  });

  it('keeps Save pressable and sends nothing when nothing has changed (inner#1652)', () => {
    const onSave = vi.fn();
    renderSection({ onSave });
    const save = screen.getByTestId('settings-save');
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.queryByText('studio.container.dialog.nameRequired'),
    ).not.toBeInTheDocument();
  });

  it('says a name is needed when it is emptied, and focuses it (inner#1652)', () => {
    const onSave = vi.fn();
    renderSection({ onSave });
    const name = screen.getByTestId('settings-name');
    fireEvent.change(name, { target: { value: '   ' } });
    const save = screen.getByTestId('settings-save');
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText('studio.container.dialog.nameRequired'),
    ).toHaveClass('text-xs');
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(name, { target: { value: 'A' } });
    expect(
      screen.queryByText('studio.container.dialog.nameRequired'),
    ).not.toBeInTheDocument();
  });

  it('holds both fields read-only, not greyed, while any settings save is out (inner#1652)', () => {
    render(
      <BasicInfoSection studio={STUDIO} canEdit saving savingDetails={false} onSave={vi.fn()} />,
    );
    for (const id of ['settings-name', 'settings-bio']) {
      expect(screen.getByTestId(id)).toHaveAttribute('readonly');
      expect(screen.getByTestId(id)).not.toBeDisabled();
    }
  });

  it('ignores a press while any settings save is out (inner#1652)', () => {
    const onSave = vi.fn();
    const tree = (saving: boolean): React.JSX.Element => (
      <BasicInfoSection
        studio={STUDIO}
        canEdit
        saving={saving}
        savingDetails={false}
        onSave={onSave}
      />
    );
    const { rerender } = render(tree(false));
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    // A slug change is out: Save does not spin, but a press does nothing.
    rerender(tree(true));
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(onSave).not.toHaveBeenCalled();
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

  it('marks Save busy while the save is out, and clears it once answered', () => {
    const onSave = vi.fn();
    const tree = (saving: boolean): React.JSX.Element => (
      <BasicInfoSection
        studio={STUDIO}
        canEdit
        saving={saving}
        savingDetails={saving}
        onSave={onSave}
      />
    );
    const { rerender } = render(tree(false));
    fireEvent.change(screen.getByTestId('settings-name'), {
      target: { value: 'Acme Inc' },
    });
    fireEvent.click(screen.getByTestId('settings-save'));

    rerender(tree(true));
    const save = screen.getByTestId('settings-save');
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveTextContent('studio.container.settings.saving');

    rerender(tree(false));
    expect(save).not.toHaveAttribute('aria-busy');
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
