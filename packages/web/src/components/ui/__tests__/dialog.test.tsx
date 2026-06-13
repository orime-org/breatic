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

  it('title stack reserves chrome height + centers (title-only stays vertically aligned to the close button)', () => {
    setup(true);
    // The header keeps items-start (so multi-line title+description aligns the
    // close X to the title's first line); the title/description stack itself
    // gets a chrome-height floor + justify-center so a title-only header centers
    // its single line against the 32px close button instead of top-aligning.
    const titleStack = screen.getByText('Title').parentElement;
    expect(titleStack?.className).toContain('min-h-[var(--btn-chrome)]');
    expect(titleStack?.className).toContain('justify-center');
  });

  it('content carries bg-card + rounded-overlay + border tokens', () => {
    setup(true);
    const content = screen.getByTestId('content');
    expect(content.className).toContain('bg-card');
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
