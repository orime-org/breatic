import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Input } from '@web/components/ui/input';

describe('Input', () => {
  it('renders an <input> element with the given type', () => {
    render(<Input type='email' data-testid='input' />);
    const el = screen.getByTestId('input');
    expect(el.tagName).toBe('INPUT');
    expect(el).toHaveAttribute('type', 'email');
  });

  it('applies project token classes (border-border default + focus-visible swaps to active-border + no shadow + no ring)', () => {
    render(<Input data-testid='input' />);
    const el = screen.getByTestId('input');
    // Per 2026-05-25 (PR #135 final): Input mirrors the segmented-
    // control cards' active/inactive system in the same dialog —
    // default `border-border` (= unselected card), focus swaps to
    // `border-active-border` (= selected card). Border thickness stays
    // 1 px on focus (no ring layered on top — that visibly thickened
    // the input edge).
    expect(el.className).toContain('border-border');
    expect(el.className).toContain('focus-visible:border-active-border');
    expect(el.className).toContain('bg-transparent');
    expect(el.className).not.toContain('shadow-sm');
    expect(el.className).not.toContain('focus-visible:ring-1');
  });

  it('exposes placeholder + disabled + readonly to a11y tree', () => {
    render(
      <Input placeholder='Enter email' disabled aria-label='Email' />,
    );
    const el = screen.getByLabelText('Email');
    expect(el).toHaveAttribute('placeholder', 'Enter email');
    expect(el).toBeDisabled();
  });

  it('merges custom className with default tokens (tailwind-merge)', () => {
    render(<Input data-testid='input' className='h-10' />);
    const el = screen.getByTestId('input');
    // h-9 default should be overridden by h-10 via tailwind-merge in cn().
    expect(el.className).toContain('h-10');
    expect(el.className).not.toContain('h-9');
  });

  it('forwards ref to the underlying <input>', () => {
    let captured: HTMLInputElement | null = null;
    render(
      <Input
        ref={(el) => {
          captured = el;
        }}
      />,
    );
    expect(captured).toBeInstanceOf(HTMLInputElement);
  });
});
