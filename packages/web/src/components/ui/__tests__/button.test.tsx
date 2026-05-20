import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders a <button> with text content', () => {
    render(<Button>Click me</Button>);
    const el = screen.getByRole('button', { name: 'Click me' });
    expect(el.tagName).toBe('BUTTON');
  });

  it('default variant applies primary tokens', () => {
    render(<Button>Default</Button>);
    expect(
      screen.getByRole('button').className,
    ).toContain('bg-primary');
  });

  it('outline variant applies border + background tokens', () => {
    render(<Button variant='outline'>Outline</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('border');
    expect(cls).toContain('bg-background');
  });

  it('size=icon collapses to square 10×10', () => {
    render(<Button size='icon' aria-label='Pick'>i</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('h-10');
    expect(cls).toContain('w-10');
  });

  it('asChild renders the wrapped element instead of a button', () => {
    render(
      <Button asChild>
        <a href='/x'>Link</a>
      </Button>,
    );
    const el = screen.getByRole('link', { name: 'Link' });
    expect(el.tagName).toBe('A');
  });

  it('onClick fires on click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
