// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Rename-project dialog: Save is always pressable (inner#1652). An empty name
 * says so under the field; an unchanged name closes the dialog with nothing
 * sent; a new name goes to the caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RenameProjectDialog } from '@web/pages/studio/container/cards/RenameProjectDialog';

/**
 * Render the dialog open on a project named "Spring".
 * @param pending - Whether a rename is in flight.
 * @returns The rename and close spies.
 */
function setup(pending = false): { onRename: ReturnType<typeof vi.fn>; onOpenChange: ReturnType<typeof vi.fn> } {
  const onRename = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <RenameProjectDialog open onOpenChange={onOpenChange} currentName='Spring' onRename={onRename} pending={pending} />,
  );
  return { onRename, onOpenChange };
}

describe('RenameProjectDialog (inner#1652)', () => {
  it('keeps Save pressable and says a name is needed when it is cleared', async () => {
    const user = userEvent.setup();
    const { onRename } = setup();
    const name = screen.getByRole('textbox');
    await user.clear(name);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).not.toBeDisabled();
    await user.click(save);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a name.')).toHaveClass('text-xs');
    expect(name).toHaveFocus();
    await user.type(name, 'S');
    expect(screen.queryByText('Enter a name.')).not.toBeInTheDocument();
  });

  it('opens again without the reason left from the last opening', async () => {
    const user = userEvent.setup();
    const props = { onOpenChange: vi.fn(), currentName: 'Spring', onRename: vi.fn(), pending: false };
    const { rerender } = render(<RenameProjectDialog open {...props} />);
    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    rerender(<RenameProjectDialog open={false} {...props} />);
    rerender(<RenameProjectDialog open {...props} />);
    expect(screen.queryByText('Enter a name.')).not.toBeInTheDocument();
  });

  it('closes without sending anything when the name is unchanged', async () => {
    const user = userEvent.setup();
    const { onRename, onOpenChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRename).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends a new name', async () => {
    const user = userEvent.setup();
    const { onRename } = setup();
    const name = screen.getByRole('textbox');
    await user.clear(name);
    await user.type(name, '  Autumn  {Enter}');
    expect(onRename).toHaveBeenCalledWith('Autumn', expect.anything());
  });

  it('ignores a press while the rename is out', async () => {
    const user = userEvent.setup();
    const { onRename, onOpenChange } = setup(true);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRename).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves the browser out of it: no native required check', () => {
    setup();
    expect(document.body.querySelector('form')).toHaveAttribute('novalidate');
    expect(screen.getByRole('textbox')).not.toHaveAttribute('required');
  });
});
