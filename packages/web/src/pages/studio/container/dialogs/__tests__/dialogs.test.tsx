// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewItemDialog } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { NewStudioDialog } from '@web/pages/studio/container/dialogs/NewStudioDialog';

describe('NewItemDialog (spec §3.12)', () => {
  it('renders the project title and the name + slug fields when open', () => {
    render(<NewItemDialog kind='project' open onOpenChange={() => {}} />);
    expect(screen.getByText('New project')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Handle')).toBeInTheDocument();
  });

  it('blocks submit and shows an error for a malformed slug', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} onCreate={onCreate} />,
    );
    await user.type(screen.getByLabelText('Name'), 'My Project');
    await user.type(screen.getByLabelText('Handle'), 'Bad_Slug');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/Lowercase letters/)).toBeInTheDocument();
  });

  it('reports valid values (defaulting visibility to studio) and closes on submit', async () => {
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
    await user.type(screen.getByLabelText('Handle'), 'mood-board');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Moodboard',
      slug: 'mood-board',
      description: '',
      visibility: 'studio',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reports visibility=private when the Private option is chosen', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewItemDialog kind='project' open onOpenChange={() => {}} onCreate={onCreate} />,
    );
    await user.type(screen.getByLabelText('Name'), 'Secret');
    await user.type(screen.getByLabelText('Handle'), 'secret-proj');
    await user.click(screen.getByLabelText(/invite only/));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Secret',
      slug: 'secret-proj',
      description: '',
      visibility: 'private',
    });
  });
});

describe('NewStudioDialog (spec §3.12 + §5.7 globally-unique slug)', () => {
  const taken = new Set(['acme-studio']);

  it('rejects a reserved studio slug', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewStudioDialog
        open
        onOpenChange={() => {}}
        takenSlugs={taken}
        onCreate={onCreate}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Studio');
    await user.type(screen.getByLabelText('Handle'), 'studio');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/in use/)).toBeInTheDocument();
  });

  it('rejects an already-taken studio slug', async () => {
    const user = userEvent.setup();
    render(<NewStudioDialog open onOpenChange={() => {}} takenSlugs={taken} />);
    await user.type(screen.getByLabelText('Name'), 'Acme');
    await user.type(screen.getByLabelText('Handle'), 'acme-studio');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText(/in use/)).toBeInTheDocument();
  });

  it('creates with the chosen type on a valid unique slug', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <NewStudioDialog
        open
        onOpenChange={() => {}}
        takenSlugs={taken}
        onCreate={onCreate}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Nova');
    await user.click(screen.getByLabelText('Team'));
    await user.type(screen.getByLabelText('Handle'), 'nova-lab');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Nova',
      slug: 'nova-lab',
      type: 'team',
    });
  });
});
