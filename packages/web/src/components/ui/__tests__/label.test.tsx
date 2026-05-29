import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Label } from '@web/components/ui/label';

describe('Label', () => {
  it('renders a <label> element with text', () => {
    render(<Label>Email</Label>);
    const el = screen.getByText('Email');
    expect(el.tagName).toBe('LABEL');
  });

  it('applies default token classes (text-sm + font-medium)', () => {
    render(<Label>Email</Label>);
    const el = screen.getByText('Email');
    expect(el.className).toContain('text-sm');
    expect(el.className).toContain('font-medium');
  });

  it('focuses associated input via htmlFor on click', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Label htmlFor='email-input'>Email</Label>
        <input id='email-input' type='email' />
      </>,
    );
    const label = screen.getByText('Email');
    const input = screen.getByRole('textbox');
    await user.click(label);
    expect(input).toHaveFocus();
  });

  it('merges custom className with default tokens (tailwind-merge)', () => {
    render(<Label className='text-base'>Email</Label>);
    const el = screen.getByText('Email');
    // Custom text-base overrides default text-sm via tailwind-merge in cn().
    expect(el.className).toContain('text-base');
    expect(el.className).not.toContain('text-sm');
  });

  it('forwards ref to the underlying <label>', () => {
    let captured: HTMLLabelElement | null = null;
    render(
      <Label
        ref={(el) => {
          captured = el;
        }}
      >
        Email
      </Label>,
    );
    expect(captured).toBeInstanceOf(HTMLLabelElement);
  });
});
