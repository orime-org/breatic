import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@web/components/ui/alert-dialog';
import {
  expectContentIsInFlow,
  expectContentScrollsInsideOverlay,
  expectExitAnimationsMatch,
} from '@web/test-utils/overlay-scroll';

function setup(open: boolean) {
  return render(
    <AlertDialog open={open}>
      <AlertDialogTrigger asChild>
        <button type='button'>Delete</button>
      </AlertDialogTrigger>
      <AlertDialogContent data-testid='content'>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
}

describe('AlertDialog', () => {
  it('renders trigger asChild when closed', () => {
    setup(false);
    const triggers = screen.getAllByRole('button', { name: 'Delete' });
    expect(triggers.length).toBeGreaterThan(0);
  });

  it('does NOT render content when closed', () => {
    setup(false);
    expect(screen.queryByText('Confirm')).not.toBeInTheDocument();
  });

  it('renders title + description + Action + Cancel when open', () => {
    setup(true);
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('puts the content inside the overlay, in a Scroller, so a tall dialog can be reached', () => {
    setup(true);
    expectContentScrollsInsideOverlay(screen.getByTestId('content'));
  });

  it('drops the fixed centering the content used to do on its own', () => {
    setup(true);
    expectContentIsInFlow(screen.getByTestId('content'));
  });

  it('gives the overlay the transition length the content animates for', () => {
    setup(true);
    expectExitAnimationsMatch(screen.getByTestId('content'));
  });

  it('Action button carries primary tokens', () => {
    setup(true);
    const actions = screen.getAllByRole('button', { name: 'Delete' });
    const action = actions.find((b) => b.className.includes('bg-primary'));
    expect(action).toBeDefined();
    expect(action!.className).toContain('text-primary-foreground');
  });

  it('Cancel button carries outline tokens (border-border + bg-background)', () => {
    setup(true);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // Outline buttons share the visible form-control hairline (border-border).
    expect(cancel.className).toContain('border-border');
    expect(cancel.className).not.toContain('border-input');
    expect(cancel.className).toContain('bg-background');
  });
});

/**
 * A controlled confirm dialog whose Action can be put in its waiting state.
 * @param props - Initial loading flag and the Action click spy.
 * @param props.loading - Whether the Action starts out waiting.
 * @param props.onAction - Called when the Action is clicked.
 * @param props.keepOpen - Whether the Action's handler prevents the close.
 * @returns The dialog.
 */
function Controlled({
  loading,
  onAction,
  keepOpen = false,
}: {
  loading: boolean;
  onAction: () => void;
  keepOpen?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(true);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent data-testid='content'>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            loading={loading}
            onClick={(event) => {
              if (keepOpen) event.preventDefault();
              onAction();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe('AlertDialogAction loading', () => {
  it('shows a spinner and is aria-disabled while loading', () => {
    render(<Controlled loading onAction={vi.fn()} />);
    const action = screen.getByRole('button', { name: 'Delete' });
    expect(action).toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveAttribute('aria-disabled', 'true');
    expect(action.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('neither closes the dialog nor calls onClick when pressed while loading', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Controlled loading onAction={onAction} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('stays open when the caller prevents the default close', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Controlled loading={false} onAction={onAction} keepOpen />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('closes on a plain press when idle', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Controlled loading={false} onAction={onAction} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('content')).toBeNull();
  });
});
