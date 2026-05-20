import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NewProjectDialog } from '@/pages/studio/grid/NewProjectDialog';

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
