import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Textarea } from '@/components/ui/textarea';

describe('Textarea', () => {
  it('renders a <textarea> element', () => {
    render(<Textarea data-testid='ta' />);
    const el = screen.getByTestId('ta');
    expect(el.tagName).toBe('TEXTAREA');
  });

  it('applies project token classes (border-input + bg-transparent)', () => {
    render(<Textarea data-testid='ta' />);
    const el = screen.getByTestId('ta');
    expect(el.className).toContain('border-input');
    expect(el.className).toContain('bg-transparent');
  });

  it('exposes placeholder + disabled + aria-label to a11y tree', () => {
    render(
      <Textarea
        placeholder='Write description'
        disabled
        aria-label='Description'
      />,
    );
    const el = screen.getByLabelText('Description');
    expect(el).toHaveAttribute('placeholder', 'Write description');
    expect(el).toBeDisabled();
  });

  it('merges custom className with default tokens (tailwind-merge)', () => {
    render(<Textarea data-testid='ta' className='min-h-[120px]' />);
    const el = screen.getByTestId('ta');
    // Custom min-h overrides default min-h-[60px] via tailwind-merge in cn().
    expect(el.className).toContain('min-h-[120px]');
    expect(el.className).not.toContain('min-h-[60px]');
  });

  it('forwards ref to the underlying <textarea>', () => {
    let captured: HTMLTextAreaElement | null = null;
    render(
      <Textarea
        ref={(el) => {
          captured = el;
        }}
      />,
    );
    expect(captured).toBeInstanceOf(HTMLTextAreaElement);
  });
});
