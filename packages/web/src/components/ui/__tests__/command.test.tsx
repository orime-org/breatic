import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@web/components/ui/command';

describe('Command', () => {
  it('renders root with bg-popover + text-popover-foreground tokens', () => {
    render(
      <Command data-testid='cmd'>
        <CommandInput placeholder='Search' />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
        </CommandList>
      </Command>,
    );
    const root = screen.getByTestId('cmd');
    expect(root.className).toContain('bg-popover');
    expect(root.className).toContain('text-popover-foreground');
  });

  it('CommandInput renders <input> with placeholder + search icon', () => {
    render(
      <Command>
        <CommandInput placeholder='Search skills' />
      </Command>,
    );
    const input = screen.getByPlaceholderText('Search skills');
    expect(input.tagName).toBe('INPUT');
  });

  it('renders CommandGroup heading + items', () => {
    render(
      <Command>
        <CommandList>
          <CommandGroup heading='Tools'>
            <CommandItem>Remove bg</CommandItem>
            <CommandItem>Upscale</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('Remove bg')).toBeInTheDocument();
    expect(screen.getByText('Upscale')).toBeInTheDocument();
  });

  it('CommandShortcut renders with muted-foreground + ml-auto (standalone)', () => {
    render(<CommandShortcut data-testid='sc'>⌘K</CommandShortcut>);
    const sc = screen.getByTestId('sc');
    expect(sc).toHaveTextContent('⌘K');
    expect(sc.className).toContain('text-muted-foreground');
    expect(sc.className).toContain('ml-auto');
  });

  it('CommandEmpty shows fallback message when no items match', () => {
    render(
      <Command>
        <CommandInput value='zzz_no_match' onValueChange={() => {}} />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
          <CommandGroup>
            <CommandItem>OnlyItem</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('caps the list height at 300px when no viewport class is given', () => {
    // The default is what every caller before #1960 relies on, so a new prop
    // that quietly replaced it would shorten or lengthen those lists.
    const { container } = render(
      <Command>
        <CommandList>
          <CommandItem>Item</CommandItem>
        </CommandList>
      </Command>,
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport?.className).toContain('max-h-[300px]');
  });

  it('lets a caller style the element that scrolls', () => {
    const { container } = render(
      <Command>
        <CommandList viewportClassName='max-h-52'>
          <CommandItem>Item</CommandItem>
        </CommandList>
      </Command>,
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport?.className).toContain('max-h-52');
    expect(viewport?.className).not.toContain('max-h-[300px]');
  });

  it('hands the scrolling element to a caller that pages as it is read', () => {
    // A list fetched a page at a time has to listen on the element that
    // scrolls, and that element belongs to the ScrollArea in here.
    let scroller: HTMLElement | null = null;
    render(
      <Command>
        <CommandList
          viewportRef={(el): void => {
            scroller = el;
          }}
        >
          <CommandItem>Item</CommandItem>
        </CommandList>
      </Command>,
    );
    expect(scroller).not.toBeNull();
    expect(
      (scroller as unknown as HTMLElement).getAttribute(
        'data-radix-scroll-area-viewport',
      ),
    ).not.toBeNull();
  });
});
