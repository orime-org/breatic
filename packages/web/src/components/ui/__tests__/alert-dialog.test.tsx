import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

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
  findOverlay,
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
    expectExitAnimationsMatch(findOverlay(), screen.getByTestId('content'));
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
