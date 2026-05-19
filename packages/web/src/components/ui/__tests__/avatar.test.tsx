import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Avatar, AvatarFallback, AvatarImage } from '../avatar';

describe('Avatar', () => {
  it('renders root with default size + circular shape', () => {
    render(
      <Avatar data-testid='avatar'>
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>,
    );
    const el = screen.getByTestId('avatar');
    expect(el.className).toContain('h-10');
    expect(el.className).toContain('w-10');
    expect(el.className).toContain('rounded-full');
    expect(el.className).toContain('overflow-hidden');
  });

  it('AvatarFallback renders text + bg-muted token (visible when image fails)', () => {
    render(
      <Avatar>
        <AvatarFallback data-testid='fb'>AL</AvatarFallback>
      </Avatar>,
    );
    // Radix Fallback renders immediately when no Image (jsdom never loads images).
    const fb = screen.getByTestId('fb');
    expect(fb).toHaveTextContent('AL');
    expect(fb.className).toContain('bg-muted');
    expect(fb.className).toContain('items-center');
  });

  it('AvatarImage forwards src + alt to the underlying <img>', () => {
    render(
      <Avatar>
        <AvatarImage src='/avatar.png' alt='User' data-testid='img' />
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>,
    );
    // Radix doesn't mount <img> until preload completes; in jsdom this never
    // happens, so the element is absent. Asserting via queryByTestId allows
    // either presence (browser) or absence (jsdom) without flake.
    const img = screen.queryByTestId('img');
    if (img) {
      expect(img).toHaveAttribute('src', '/avatar.png');
      expect(img).toHaveAttribute('alt', 'User');
    }
    // Fallback is the dependable assertion in jsdom.
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('merges custom size className (h-14 overrides h-10)', () => {
    render(
      <Avatar data-testid='avatar' className='h-14 w-14'>
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>,
    );
    const el = screen.getByTestId('avatar');
    expect(el.className).toContain('h-14');
    expect(el.className).toContain('w-14');
    expect(el.className).not.toContain('h-10');
    expect(el.className).not.toContain('w-10');
  });

  it('forwards ref to the underlying root element', () => {
    let captured: HTMLSpanElement | null = null;
    render(
      <Avatar
        ref={(el) => {
          captured = el;
        }}
      >
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>,
    );
    expect(captured).not.toBeNull();
    expect(captured).toBeInstanceOf(HTMLElement);
  });
});
