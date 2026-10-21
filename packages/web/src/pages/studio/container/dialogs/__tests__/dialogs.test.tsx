// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';

import { NewItemDialog } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { NewStudioDialog } from '@web/pages/studio/container/dialogs/NewStudioDialog';
import { PROJECT_CREATE_INTENT } from '@web/pages/studio/container/dialogs/use-create-project';
import { runOnce } from '@web/stores/task-actions-in-flight';
import {
  slugFieldShowsConflict,
  useSlugAvailability,
} from '@web/pages/studio/container/dialogs/use-slug-availability';
import { useCreateStudio } from '@web/pages/studio/container/dialogs/use-create-studio';
import { ApiException } from '@web/data/api/types';
import type { SlugCheck } from '@web/pages/studio/container/dialogs/slug-util';

// The field-shown tracker stays real: it is what decides where a refused
// create is reported.
vi.mock('@web/pages/studio/container/dialogs/use-slug-availability', async (importOriginal) => ({
  useSlugAvailability: vi.fn(),
  slugFieldShowsConflict: vi.fn(),
  useSlugFieldShown: (await importOriginal<
    typeof import('@web/pages/studio/container/dialogs/use-slug-availability')
  >()).useSlugFieldShown,
}));
vi.mock('@web/pages/studio/container/dialogs/use-create-studio');

type User = ReturnType<typeof userEvent.setup>;

/**
 * Replace whatever the slug field holds with a value of the reader's own.
 * @param user - The user-event session.
 * @param value - The slug to type.
 */
async function typeSlug(user: User, value: string): Promise<void> {
  await user.clear(slugInput());
  await user.type(slugInput(), value);
}

/**
 * The slug input, whose label reads "Slug (optional)" in the item dialog.
 * @returns The input.
 */
function slugInput(): HTMLElement {
  return screen.getByLabelText(/^Slug/);
}

describe('NewItemDialog (spec §3.12)', () => {
  it('renders the project title and the name + slug fields when open', () => {
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    expect(screen.getByText('New project')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Slug (optional)')).toBeInTheDocument();
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

  it('describes the slug, with its length and that it follows the name', () => {
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    const line = screen.getByTestId('new-project-slug-hint');
    expect(line).toHaveTextContent('6–50 characters');
    expect(line).toHaveTextContent('it follows the name');
  });

  it('uses collection placeholders in the collection dialog', () => {
    render(<NewItemDialog kind='collection' open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'My collection');
    expect(slugInput()).toHaveAttribute('placeholder', 'my-collection');
  });

  it('has no description field and sends none (inner#1463)', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewItemDialog kind='collection' open onOpenChange={vi.fn()} onCreate={onCreate} />);
    expect(screen.queryByLabelText(/Description/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Moodboard');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    // An exact match, so a visibility or description field creeping back in fails here.
    expect(onCreate).toHaveBeenCalledWith({ name: 'Moodboard', slug: 'moodboard' });
  });

  it('reports a project without any visibility field', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} onCreate={onCreate} />,
    );
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await typeSlug(user, 'fresh-proj');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Fresh',
      slug: 'fresh-proj',
      spaceType: 'canvas',
    });
  });

  it('submits the trimmed slug the reader typed', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} onCreate={onCreate} />,
    );
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await typeSlug(user, '  fresh-proj  ');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'fresh-proj' }),
    );
  });

  it('leaves the browser out of it: no native required check on the form', () => {
    const { container } = render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    const form = (document.body.querySelector('form') ?? container.querySelector('form'))!;
    expect(form).toHaveAttribute('novalidate');
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('required');
  });
});

describe('NewItemDialog — reasons on press and an optional slug (inner#1652, inner#1463)', () => {
  it('keeps Create pressable and says a name is needed under the name field', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} onCreate={onCreate} />);
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).not.toBeDisabled();
    expect(create).not.toHaveAttribute('aria-disabled');

    await user.click(create);
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');

    await user.type(screen.getByLabelText('Name'), 'A');
    expect(screen.queryByText('Enter a name.')).not.toBeInTheDocument();
  });

  it('fills the slug from the name as it is typed', async () => {
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Spring Campaign');
    expect(slugInput()).toHaveValue('spring-campaign');
  });

  it('stops following the name once the reader edits the slug', async () => {
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Spring');
    await typeSlug(user, 'my-own-slug');
    await user.type(screen.getByLabelText('Name'), ' Campaign');
    expect(slugInput()).toHaveValue('my-own-slug');
  });

  it('keeps a cleared slug empty until the name changes again', async () => {
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Spring Campaign');
    await user.clear(slugInput());
    expect(slugInput()).toHaveValue('');
    await user.type(screen.getByLabelText('Name'), 's');
    expect(slugInput()).toHaveValue('spring-campaigns');
  });

  it.each([
    ['project', '我的项目', 'project'],
    ['collection', '我的素材', 'collection'],
  ] as const)('gives a %s with no Latin letters in its name the fallback slug', async (kind, name, slug) => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewItemDialog kind={kind} open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await user.type(screen.getByLabelText('Name'), name);
    expect(slugInput()).toHaveValue(slug);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ slug }));
  });

  it('makes a slug from the name when the slug is left empty at press', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await user.type(screen.getByLabelText('Name'), 'Spring Campaign');
    await user.clear(slugInput());
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ slug: 'spring-campaign' }));
  });

  it('refuses a malformed slug pressed before the typing check settles, and says why', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await user.clear(slugInput());
    await user.type(slugInput(), 'Bad_Slug{Enter}');
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-project-slug-hint')).toHaveTextContent(/Start with a lowercase letter/);
    expect(slugInput()).toHaveFocus();
  });

  it('shows the description line, not an availability line, for a valid slug', async () => {
    const user = userEvent.setup();
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Spring Campaign');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const line = screen.getByTestId('new-project-slug-hint');
    expect(line).toHaveTextContent('it follows the name');
    expect(line).not.toHaveTextContent(/available|Checking/);
  });
});

describe('NewItemDialog — submitting (#255)', () => {
  // inner#1490: a create is held outside the dialog, so a dialog opened while
  // one is out — from either entry, with any studio picked — shows Create busy.
  it('shows Create busy while a project create is out', () => {
    void runOnce(PROJECT_CREATE_INTENT, {
      scope: 'project',
      prepare: () => new Promise<null>(() => {}),
      send: vi.fn(),
    });
    render(<NewItemDialog kind='project' open onOpenChange={vi.fn()} onCreate={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Create' });
    expect(button).toHaveAttribute('aria-busy', 'true');
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
    await user.click(screen.getByRole('button', { name: 'Create' }));

    // The label stays, so the button is still addressable by its name — which
    // is the reason the label stays.
    const button = screen.getByRole('button', { name: 'Create' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      settle();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(button).not.toHaveAttribute('aria-busy');
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
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await act(async () => {
      refuse(new Error('Access denied'));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create' })).not.toHaveAttribute('aria-busy');
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
   * Drive `useSlugAvailability` to a fixed check for the test (the hook's own
   * race-safety is covered in use-slug-availability.test.tsx).
   * @param check the check the hook returns.
   */
  function setAvailability(check: SlugCheck): void {
    vi.mocked(useSlugAvailability).mockReturnValue(check);
  }

  /**
   * Answer the 409 re-ask as "taken", deferring to the dialog on whether the
   * slug field is still on screen to show it.
   */
  function slugTakenOnReask(): void {
    vi.mocked(slugFieldShowsConflict).mockImplementation(
      async (_client, _err, _slug, fieldShown) => fieldShown(),
    );
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
    vi.mocked(slugFieldShowsConflict).mockReset();
    vi.mocked(useCreateStudio).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateStudio>);
    setAvailability({ state: 'empty' });
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
    setAvailability({ state: 'checking' });
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('describes the slug, with its length, and shows studio placeholders while empty', () => {
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByTestId('new-studio-slug-hint')).toHaveTextContent('6–39 characters');
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'My studio');
    expect(screen.getByLabelText('Slug')).toHaveAttribute('placeholder', 'my-studio');
  });

  it('leaves a slug taken by a racing submit to the slug line, with no form error', async () => {
    setAvailability({ state: 'valid' });
    slugTakenOnReask();
    const user = userEvent.setup();
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const { onError } = mockMutate.mock.calls[0][1];
    await act(async () => {
      onError(new ApiException({ status: 409, message: 'That slug is already taken.', fromServer: true }));
    });
    expect(slugFieldShowsConflict).toHaveBeenCalledWith(
      expect.any(QueryClient),
      expect.any(ApiException),
      'nova-lab',
      expect.any(Function),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the form error for a taken slug when the dialog was closed before the answer', async () => {
    setAvailability({ state: 'valid' });
    slugTakenOnReask();
    const user = userEvent.setup();
    const client = new QueryClient();
    const tree = (open: boolean): ReactElement => (
      <QueryClientProvider client={client}>
        <NewStudioDialog open={open} onOpenChange={() => {}} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree(true));
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const { onError } = mockMutate.mock.calls[0][1];
    rerender(tree(false));
    await act(async () => {
      onError(new ApiException({ status: 409, message: 'That slug is already taken.', fromServer: true }));
    });
    rerender(tree(true));
    expect(screen.getByRole('alert')).toHaveTextContent('That slug is already taken.');
  });

  it('keeps the form error for a taken slug when the dialog was reopened before the answer', async () => {
    setAvailability({ state: 'valid' });
    slugTakenOnReask();
    const user = userEvent.setup();
    const client = new QueryClient();
    const tree = (open: boolean): ReactElement => (
      <QueryClientProvider client={client}>
        <NewStudioDialog open={open} onOpenChange={() => {}} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree(true));
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const { onError } = mockMutate.mock.calls[0][1];
    // Closing goes through the dialog's own handler, which clears the form.
    await user.keyboard('{Escape}');
    rerender(tree(false));
    rerender(tree(true));
    await act(async () => {
      onError(new ApiException({ status: 409, message: 'That slug is already taken.', fromServer: true }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('That slug is already taken.');
  });

  it('holds both fields while the create is out', () => {
    vi.mocked(useCreateStudio).mockReturnValue({
      mutate: mockMutate,
      isPending: true,
    } as unknown as ReturnType<typeof useCreateStudio>);
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByLabelText('Slug')).toBeDisabled();
  });

  it('marks Create busy while the create is out, and clears it once answered', () => {
    const client = new QueryClient();
    const tree = (): ReactElement => (
      <QueryClientProvider client={client}>
        <NewStudioDialog open onOpenChange={() => {}} />
      </QueryClientProvider>
    );
    vi.mocked(useCreateStudio).mockReturnValue({
      mutate: mockMutate,
      isPending: true,
    } as unknown as ReturnType<typeof useCreateStudio>);
    const { rerender } = render(tree());
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toHaveAttribute('aria-busy', 'true');
    expect(create).toHaveAttribute('aria-disabled', 'true');

    vi.mocked(useCreateStudio).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateStudio>);
    rerender(tree());
    expect(create).not.toHaveAttribute('aria-busy');
  });

  it('keeps a 409 that is not about the slug as a form error', async () => {
    setAvailability({ state: 'valid' });
    vi.mocked(slugFieldShowsConflict).mockResolvedValue(false);
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
    setAvailability({ state: 'valid' });
    renderStudio(<NewStudioDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Slug is available')).toBeInTheDocument();
  });

  it('submits the name + slug (no type) when the slug is available', async () => {
    setAvailability({ state: 'valid' });
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

describe('NewStudioDialog — reasons on press and waiting for the check (inner#1652)', () => {
  const mutate = vi.fn();

  beforeEach(() => {
    mutate.mockReset();
    vi.mocked(useCreateStudio).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateStudio>);
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'empty' });
  });

  /**
   * Render the dialog in a query client with an open flag the test can change.
   * @returns The rerender, taking the next open flag.
   */
  function renderOpen(): (open: boolean) => void {
    const client = new QueryClient();
    const onOpenChange = vi.fn();
    const tree = (open: boolean): ReactElement => (
      <QueryClientProvider client={client}>
        <NewStudioDialog open={open} onOpenChange={onOpenChange} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree(true));
    return (open) => rerender(tree(open));
  }

  it('keeps Create pressable and names every missing field, focusing the first', async () => {
    const user = userEvent.setup();
    renderOpen();
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).not.toBeDisabled();
    await user.click(create);
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(screen.getByTestId('new-studio-slug-hint')).toHaveTextContent('Enter a slug.');
    expect(screen.getByLabelText('Name')).toHaveFocus();

    await user.type(screen.getByLabelText('Name'), 'N');
    expect(screen.queryByText('Enter a name.')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Slug'), 'n');
    expect(screen.getByTestId('new-studio-slug-hint')).not.toHaveTextContent('Enter a slug.');
  });

  it('focuses the slug when it is the field in the way', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'invalid', reason: 'taken' });
    const user = userEvent.setup();
    renderOpen();
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.type(screen.getByLabelText('Slug'), 'acme-studio');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/in use/)).toBeInTheDocument();
    expect(screen.getByLabelText('Slug')).toHaveFocus();
  });

  it('waits for a running check, then creates with what is on screen', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'checking' });
    const user = userEvent.setup();
    const setOpen = renderOpen();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).toHaveAttribute('aria-busy', 'true');

    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
    setOpen(true);
    expect(mutate).toHaveBeenCalledWith({ name: 'Nova', slug: 'nova-lab' }, expect.anything());
  });

  it('reports the answer instead of creating when the check comes back taken', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'checking' });
    const user = userEvent.setup();
    const setOpen = renderOpen();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'invalid', reason: 'taken' });
    setOpen(true);
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Slug')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Create' })).not.toHaveAttribute('aria-busy');
  });

  it('does not create when the slug is edited during the wait', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'checking' });
    const user = userEvent.setup();
    const setOpen = renderOpen();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await user.type(screen.getByLabelText('Slug'), 's');

    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
    setOpen(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('does not create when the dialog closes during the wait', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'checking' });
    const user = userEvent.setup();
    const setOpen = renderOpen();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    setOpen(false);

    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
    setOpen(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('checks the name again when the wait ends', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'checking' });
    const user = userEvent.setup();
    const setOpen = renderOpen();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await user.clear(screen.getByLabelText('Name'));

    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
    setOpen(true);
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
  });

  it('sends a slug the check could not reach, for the server to judge', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'unverified' });
    const user = userEvent.setup();
    renderOpen();
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.type(screen.getByLabelText('Slug'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(mutate).toHaveBeenCalledWith({ name: 'Nova', slug: 'nova-lab' }, expect.anything());
  });

  it('ignores a press while the create is out', async () => {
    vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
    vi.mocked(useCreateStudio).mockReturnValue({
      mutate,
      isPending: true,
    } as unknown as ReturnType<typeof useCreateStudio>);
    renderOpen();
    // The fields are locked while pending, so the press arrives on an empty form.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText('Enter a name.')).not.toBeInTheDocument();
  });

  it('leaves the browser out of it: no native required check', () => {
    renderOpen();
    expect(screen.getByTestId('new-studio-dialog').querySelector('form')).toHaveAttribute('novalidate');
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('required');
  });
});
