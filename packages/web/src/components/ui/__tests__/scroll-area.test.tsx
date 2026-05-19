import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ScrollArea } from '../scroll-area';

describe('ScrollArea', () => {
  it('renders root container with overflow-hidden + relative', () => {
    render(
      <ScrollArea data-testid='root' className='h-32 w-64'>
        <p>content</p>
      </ScrollArea>,
    );
    const root = screen.getByTestId('root');
    expect(root.className).toContain('relative');
    expect(root.className).toContain('overflow-hidden');
    expect(root.className).toContain('h-32');
    expect(root.className).toContain('w-64');
  });

  it('renders children inside viewport', () => {
    render(
      <ScrollArea>
        <p>Hello content</p>
      </ScrollArea>,
    );
    expect(screen.getByText('Hello content')).toBeInTheDocument();
  });

  it('viewport has h-full + w-full (fills root)', () => {
    render(
      <ScrollArea data-testid='root'>
        <p data-testid='child'>x</p>
      </ScrollArea>,
    );
    const child = screen.getByTestId('child');
    let cur: HTMLElement | null = child.parentElement;
    let found = false;
    while (cur) {
      if (cur.className.includes('h-full') && cur.className.includes('w-full')) {
        found = true;
        break;
      }
      cur = cur.parentElement;
    }
    expect(found).toBe(true);
  });

  it('viewport inherits border-radius via rounded-[inherit]', () => {
    render(
      <ScrollArea data-testid='root' className='rounded-lg'>
        <p data-testid='child'>x</p>
      </ScrollArea>,
    );
    const child = screen.getByTestId('child');
    let cur: HTMLElement | null = child.parentElement;
    let found = false;
    while (cur) {
      if (cur.className.includes('rounded-[inherit]')) {
        found = true;
        break;
      }
      cur = cur.parentElement;
    }
    expect(found).toBe(true);
  });

  it('forwards ref to root element', () => {
    let captured: HTMLDivElement | null = null;
    render(
      <ScrollArea
        ref={(el) => {
          captured = el;
        }}
      >
        <p>x</p>
      </ScrollArea>,
    );
    expect(captured).toBeInstanceOf(HTMLElement);
  });
});
