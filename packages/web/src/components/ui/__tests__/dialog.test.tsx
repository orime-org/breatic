import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@web/components/ui/dialog';

function setup(open: boolean) {
  return render(
    <Dialog open={open}>
      <DialogTrigger asChild>
        <button type='button'>Open</button>
      </DialogTrigger>
      <DialogContent data-testid='content'>
        <DialogHeader>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>,
  );
}

describe('Dialog', () => {
  it('renders trigger asChild when closed', () => {
    setup(false);
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('does NOT render content when closed', () => {
    setup(false);
    expect(screen.queryByText('Title')).not.toBeInTheDocument();
  });

  it('renders title + description + close button when open', () => {
    setup(true);
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('content carries bg-popover + rounded-overlay + border tokens', () => {
    setup(true);
    const content = screen.getByTestId('content');
    expect(content.className).toContain('bg-popover');
    expect(content.className).toContain('border-border');
    // #385+#387: unified overlay radius token (replaces sm:rounded-chrome
    // so Sheet / Dialog / Popover all share one radius source).
    expect(content.className).toContain('sm:rounded-overlay');
    expect(content.className).toContain('shadow');
    expect(content.className).toContain('max-w-[520px]');
    expect(content.className).toContain('p-0');
  });

  it('content merges custom className (tailwind-merge)', () => {
    render(
      <Dialog open>
        <DialogTrigger asChild>
          <button>x</button>
        </DialogTrigger>
        <DialogContent data-testid='content' className='max-w-2xl'>
          <DialogHeader>
            <DialogTitle>T</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    const content = screen.getByTestId('content');
    expect(content.className).toContain('max-w-2xl');
    expect(content.className).not.toContain('max-w-[520px]');
  });
});
