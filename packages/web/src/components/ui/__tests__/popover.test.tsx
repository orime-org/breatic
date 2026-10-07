import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';

function setup(open: boolean) {
  return render(
    <Popover open={open}>
      <PopoverTrigger asChild>
        <button type='button'>Open</button>
      </PopoverTrigger>
      <PopoverContent data-testid='content'>Panel body</PopoverContent>
    </Popover>,
  );
}

describe('Popover', () => {
  it('closes as soon as the pointer goes down outside, before the click', async () => {
    const onOpenChange = vi.fn();
    render(
      <Popover open onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button type='button'>Open</button>
        </PopoverTrigger>
        <PopoverContent>Panel body</PopoverContent>
      </Popover>,
    );
    // The outside-pointer listener is attached on the next tick after mount.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    fireEvent.pointerDown(document.body, { button: 0 });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders trigger as the wrapped child (asChild)', () => {
    setup(false);
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('does NOT render content when closed', () => {
    setup(false);
    expect(screen.queryByText('Panel body')).not.toBeInTheDocument();
  });

  it('renders content when open=true (controlled)', () => {
    setup(true);
    expect(screen.getByText('Panel body')).toBeInTheDocument();
  });

  it('content carries bg-popover + text-popover-foreground tokens', () => {
    setup(true);
    const content = screen.getByTestId('content');
    expect(content.className).toContain('bg-popover');
    expect(content.className).toContain('text-popover-foreground');
    // #385+#387: unified overlay radius token (replaces rounded-chrome).
    expect(content.className).toContain('rounded-overlay');
    expect(content.className).toContain('border-border');
    expect(content.className).toContain('shadow');
  });

  it('content merges custom className (tailwind-merge)', () => {
    render(
      <Popover open>
        <PopoverTrigger asChild>
          <button type='button'>O</button>
        </PopoverTrigger>
        <PopoverContent data-testid='content' className='w-96'>
          x
        </PopoverContent>
      </Popover>,
    );
    const content = screen.getByTestId('content');
    // tailwind-merge: custom w-96 overrides default w-72.
    expect(content.className).toContain('w-96');
    expect(content.className).not.toContain('w-72');
  });
});
