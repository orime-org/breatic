import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';

// jsdom lacks the pointer-capture APIs Radix touches; minimal stubs keep the
// tests focused on the rendered contract.
beforeEach(() => {
  Element.prototype.hasPointerCapture ||= () => false;
  Element.prototype.releasePointerCapture ||= () => {};
});

describe('RadioGroup', () => {
  it('renders a role=radiogroup with role=radio items', () => {
    render(
      <RadioGroup defaultValue='a'>
        <RadioGroupItem value='a' aria-label='A' />
        <RadioGroupItem value='b' aria-label='B' />
      </RadioGroup>,
    );
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('items use the visible form-control border token (border-border, not border-input)', () => {
    render(
      <RadioGroup defaultValue='a'>
        <RadioGroupItem value='a' aria-label='A' />
      </RadioGroup>,
    );
    const radio = screen.getByRole('radio', { name: 'A' });
    expect(radio.className).toContain('border-border');
    expect(radio.className).not.toContain('border-input');
  });

  it('selected item shows the neutral bg-primary dot (no brand color)', () => {
    render(
      <RadioGroup defaultValue='a'>
        <RadioGroupItem value='a' aria-label='A' />
      </RadioGroup>,
    );
    const radio = screen.getByRole('radio', { name: 'A' });
    expect(radio.querySelector('.bg-primary')).not.toBeNull();
  });
});
