import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '../sheet';

function setup(open: boolean, side?: 'left' | 'right' | 'top' | 'bottom') {
  return render(
    <Sheet open={open}>
      <SheetTrigger asChild>
        <button type='button'>Open</button>
      </SheetTrigger>
      <SheetContent side={side} data-testid='content'>
        <SheetTitle>Drawer title</SheetTitle>
        <SheetDescription>Drawer description</SheetDescription>
      </SheetContent>
    </Sheet>,
  );
}

describe('Sheet', () => {
  it('renders trigger asChild when closed', () => {
    setup(false);
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('does NOT render content when closed', () => {
    setup(false);
    expect(screen.queryByText('Drawer title')).not.toBeInTheDocument();
  });

  it('renders content + close button when open=true', () => {
    setup(true);
    expect(screen.getByText('Drawer title')).toBeInTheDocument();
    expect(screen.getByText('Drawer description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('default side=right applies right-slide tokens', () => {
    setup(true);
    const content = screen.getByTestId('content');
    expect(content.className).toContain('right-0');
    expect(content.className).toContain('border-l');
  });

  it('side=left applies left-slide tokens', () => {
    setup(true, 'left');
    const content = screen.getByTestId('content');
    expect(content.className).toContain('left-0');
    expect(content.className).toContain('border-r');
  });
});
