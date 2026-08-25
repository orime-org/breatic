// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewItemDialog } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { NewStudioDialog } from '@web/pages/studio/container/dialogs/NewStudioDialog';
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';
import { useCreateStudio } from '@web/pages/studio/container/dialogs/use-create-studio';

vi.mock('@web/pages/studio/container/dialogs/use-slug-availability');
vi.mock('@web/pages/studio/container/dialogs/use-create-studio');

describe('NewItemDialog (spec §3.12)', () => {
  it('renders the project title and the name + slug fields when open', () => {
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    expect(screen.getByText('New project')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
  });

  it('shows the space-type picker for a project but not for a collection', () => {
    const { unmount } = render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} />,
    );
    expect(
      screen.getByRole('radio', { name: /Canvas/ }),
    ).toBeInTheDocument();
    unmount();
    render(<NewItemDialog kind='collection' open onOpenChange={() => {}} />);
    expect(
      screen.queryByRole('radio', { name: /Canvas/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the always-on slug helper line', () => {
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    expect(screen.getByTestId('new-project-slug-helper')).toBeInTheDocument();
  });

  it('blocks submit and shows an error for a malformed slug', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} onCreate={onCreate} />,
    );
    await user.type(screen.getByLabelText('Name'), 'My Project');
    await user.type(screen.getByLabelText('Slug'), 'Bad_Slug');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/Lowercase letters/)).toBeInTheDocument();
  });

  it('reports valid values and closes on submit', async () => {
    const onCreate = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog
        kind='collection'
        open
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Moodboard');
    await user.type(screen.getByLabelText('Slug'), 'mood-board');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    // An exact match, so a visibility field creeping back in fails here.
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Moodboard',
      slug: 'mood-board',
      description: '',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reports a project without any visibility field', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} onCreate={onCreate} />,
    );
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await user.type(screen.getByLabelText('Slug'), 'fresh-proj');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Fresh',
      slug: 'fresh-proj',
      description: '',
      spaceType: 'canvas',
    });
  });

  it('disables Create until a name is entered and renders an outline Cancel (project-dialog parity)', async () => {
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Cancel' }).className,
    ).toContain('border-border');
    await user.type(screen.getByLabelText('Name'), 'My Project');
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('offers no visibility choice — every project is visible to the studio', () => {
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    // Neither the group nor either option. The concept left the product on
    // 2026-08-07; a picker reappearing here would put a choice back in front
    // of users that the product no longer makes. (The server still honours an
    // explicit value — that is the accepted gap of stopping at the UI layer,
    // not a reason for the dialog to offer one.)
    expect(
      screen.queryByTestId('new-project-visibility'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/invite only/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/all members/)).not.toBeInTheDocument();
  });
});

describe('NewStudioDialog (spec §3.12 + §5.7 — live slug availability)', () => {
  const mockMutate = vi.fn();

  /**
   * Drive `useSlugAvailability` to a fixed status for the test (the hook's own
   * race-safety is covered in use-slug-availability.test.tsx).
   * @param status the availability status to return.
   * @param reason the failure reason, when applicable.
   */
  function setAvailability(
    status: 'idle' | 'invalid' | 'checking' | 'available' | 'taken',
    reason?: 'format' | 'length' | 'reserved' | 'taken',
  ): void {
    vi.mocked(useSlugAvailability).mockReturnValue({ status, reason });
  }

  beforeEach(() => {
    mockMutate.mockReset();
    vi.mocked(useCreateStudio).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateStudio>);
    setAvailability('idle');
  });

  it('shows the title + name and slug fields, no type radio', () => {
    render(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('New Studio')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    // The personal/team radio is gone (a team studio is the only thing created here).
    expect(screen.queryByLabelText('Team')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Personal')).not.toBeInTheDocument();
  });

  it('shows a checking line while the slug is being verified', () => {
    setAvailability('checking');
    render(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Checking availability…')).toBeInTheDocument();
  });

  it('shows an available line for a free slug', () => {
    setAvailability('available');
    render(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Slug is available')).toBeInTheDocument();
  });

  it('shows taken and keeps Create disabled for a taken slug', async () => {
    setAvailability('taken', 'taken');
    const user = userEvent.setup();
    render(<NewStudioDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Name'), 'Acme');
    expect(screen.getByText(/in use/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('disables Create until a name is entered AND the slug is available', async () => {
    setAvailability('available');
    const user = userEvent.setup();
    render(<NewStudioDialog open onOpenChange={() => {}} />);
    // Available slug but no name yet → still disabled.
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('submits the name + slug (no type) when the slug is available', async () => {
    setAvailability('available');
    const user = userEvent.setup();
    render(<NewStudioDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(mockMutate).toHaveBeenCalledWith(
      { name: 'Nova', slug: 'nova-lab' },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });
});
