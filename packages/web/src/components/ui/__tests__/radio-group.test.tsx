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

  it('draws its unchecked ring in a border a person can see, the one the check box uses', () => {
    // Unchecked, the ring is the whole of what says the control is there:
    // `border-border` measured 1.32:1 in light and 1.22:1 in dark on the
    // questionnaire card, under WCAG 1.4.11's 3:1, beside a check box drawn
    // in `border-muted-foreground`.
    render(
      <RadioGroup defaultValue='a'>
        <RadioGroupItem value='a' aria-label='A' />
      </RadioGroup>,
    );
    const radio = screen.getByRole('radio', { name: 'A' });
    expect(radio.className).toContain('border-muted-foreground');
    expect(radio.className).not.toMatch(/(^|\s)border-border(\s|$)/);
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
