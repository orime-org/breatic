// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';

import { NewItemDialog } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { NewStudioDialog } from '@web/pages/studio/container/dialogs/NewStudioDialog';
import {
  recheckSlugTaken,
  useSlugAvailability,
} from '@web/pages/studio/container/dialogs/use-slug-availability';
import { useCreateStudio } from '@web/pages/studio/container/dialogs/use-create-studio';
import { ApiException } from '@web/data/api/types';

vi.mock('@web/pages/studio/container/dialogs/use-slug-availability');
vi.mock('@web/pages/studio/container/dialogs/use-create-studio');

type User = ReturnType<typeof userEvent.setup>;

/**
 * Type a slug and wait until the live check has called it available.
 * @param user - The user-event session.
 * @param value - The slug to type.
 */
async function typeValidSlug(user: User, value: string): Promise<void> {
  await user.type(screen.getByLabelText('Slug'), value);
  await screen.findByText('Slug is available');
}

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

  it('describes the slug, with its length, while the slug is empty', () => {
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    expect(screen.getByTestId('new-project-slug-hint')).toHaveTextContent('6–50 characters');
  });

  it('uses collection placeholders in the collection dialog', () => {
    render(<NewItemDialog kind='collection' open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'My collection');
    expect(screen.getByLabelText('Slug')).toHaveAttribute('placeholder', 'my-collection');
  });

  it('checks the slug as it is typed and holds Create while it is malformed', async () => {
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Name'), 'My Project');
    await user.type(screen.getByLabelText('Slug'), 'Bad_Slug');
    expect(await screen.findByText(/Start with a lowercase letter/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
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
    await typeValidSlug(user, 'mood-board');
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
    await typeValidSlug(user, 'fresh-proj');
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
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await typeValidSlug(user, 'my-project');
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('submits the trimmed slug it checked', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} onCreate={onCreate} />,
    );
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await typeValidSlug(user, '  fresh-proj  ');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'fresh-proj' }),
    );
  });

  it('stays open with a busy Create button until the create settles (#255)', async () => {
    const user = userEvent.setup();
    let settle: () => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    render(
      <NewItemDialog
        kind='project'
        open
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await typeValidSlug(user, 'fresh-proj');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    // The label stays, so the button is still addressable by its name — which
    // is the reason the label stays.
    const button = screen.getByRole('button', { name: 'Create' });
    expect(button).toBeDisabled();
    expect(screen.getByTestId('new-project-pending')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      settle();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open with Create pressable again when the create is refused (#255)', async () => {
    const user = userEvent.setup();
    let refuse: (reason: Error) => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const onOpenChange = vi.fn();
    render(
      <NewItemDialog
        kind='project'
        open
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await typeValidSlug(user, 'fresh-proj');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await act(async () => {
      refuse(new Error('Access denied'));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    expect(screen.queryByTestId('new-project-pending')).not.toBeInTheDocument();
    // What was typed is still there to press again.
    expect(screen.getByLabelText('Name')).toHaveValue('Fresh');
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

  /**
   * Render inside a query client, which the 409 recheck reads.
   * @param ui - The element to render.
   * @returns The render result.
   */
  function renderStudio(ui: ReactElement): ReturnType<typeof render> {
    const client = new QueryClient();
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
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
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('New Studio')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    // The personal/team radio is gone (a team studio is the only thing created here).
    expect(screen.queryByLabelText('Team')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Personal')).not.toBeInTheDocument();
  });

  it('shows a checking line while the slug is being verified', () => {
    setAvailability('checking');
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('describes the slug, with its length, and shows studio placeholders while empty', () => {
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByTestId('new-studio-slug-hint')).toHaveTextContent('6–39 characters');
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'My studio');
    expect(screen.getByLabelText('Slug')).toHaveAttribute('placeholder', 'my-studio');
  });

  it('shows a slug taken by a racing submit on the slug line, not as a form error', async () => {
    setAvailability('available');
    vi.mocked(recheckSlugTaken).mockResolvedValue(true);
    const user = userEvent.setup();
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const { onError } = mockMutate.mock.calls[0][1];
    await act(async () => {
      onError(new ApiException({ status: 409, message: 'That slug is already taken.', fromServer: true }));
    });
    expect(recheckSlugTaken).toHaveBeenCalledWith(expect.anything(), 'nova-lab');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a 409 that is not about the slug as a form error', async () => {
    setAvailability('available');
    vi.mocked(recheckSlugTaken).mockResolvedValue(false);
    const user = userEvent.setup();
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const { onError } = mockMutate.mock.calls[0][1];
    await act(async () => {
      onError(new ApiException({ status: 409, message: 'You have reached the limit of 3 team studios.', fromServer: true }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('limit of 3 team studios');
  });

  it('shows an available line for a free slug', () => {
    setAvailability('available');
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Slug is available')).toBeInTheDocument();
  });

  it('shows taken and keeps Create disabled for a taken slug', async () => {
    setAvailability('taken', 'taken');
    const user = userEvent.setup();
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Name'), 'Acme');
    expect(screen.getByText(/in use/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('disables Create until a name is entered AND the slug is available', async () => {
    setAvailability('available');
    const user = userEvent.setup();
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    // Available slug but no name yet → still disabled.
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('submits the name + slug (no type) when the slug is available', async () => {
    setAvailability('available');
    const user = userEvent.setup();
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
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
