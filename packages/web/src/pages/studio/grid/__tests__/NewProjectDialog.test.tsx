// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewProjectDialog } from '@web/pages/studio/grid/NewProjectDialog';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

describe('NewProjectDialog', () => {
  it('does NOT render content when closed', () => {
    render(<NewProjectDialog open={false} onOpenChange={() => {}} onCreate={() => {}} />);
    expect(screen.queryByText('New project')).not.toBeInTheDocument();
  });

  it('renders title + name input + template select when open', () => {
    render(<NewProjectDialog open onOpenChange={() => {}} onCreate={() => {}} />);
    expect(screen.getByText('New project')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Template')).toBeInTheDocument();
  });

  it('has no a11y violations when open', async () => {
    render(<NewProjectDialog open onOpenChange={() => {}} onCreate={() => {}} />);
    await expectNoA11yViolations(document.body);
  });

  it('Create button disabled when name is empty', () => {
    render(<NewProjectDialog open onOpenChange={() => {}} onCreate={() => {}} />);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('Create with valid name calls onCreate + closes', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onOpenChange = vi.fn();
    render(<NewProjectDialog open onOpenChange={onOpenChange} onCreate={onCreate} />);
    await user.type(screen.getByLabelText('Name'), 'My Project');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith({ name: 'My Project', template: 'canvas' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Cancel closes without calling onCreate', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onOpenChange = vi.fn();
    render(<NewProjectDialog open onOpenChange={onOpenChange} onCreate={onCreate} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
