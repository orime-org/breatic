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
} from '../command';

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
});
