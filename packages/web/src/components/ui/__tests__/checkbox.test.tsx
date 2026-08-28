import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Checkbox } from '@web/components/ui/checkbox';

// jsdom lacks the pointer-capture APIs Radix touches; minimal stubs keep the
// tests focused on the rendered contract.
beforeEach(() => {
  Element.prototype.hasPointerCapture ||= () => false;
  Element.prototype.releasePointerCapture ||= () => {};
});

describe('Checkbox', () => {
  it('renders a role=checkbox control', () => {
    render(<Checkbox aria-label='Accept' />);
    expect(
      screen.getByRole('checkbox', { name: 'Accept' }),
    ).toBeInTheDocument();
  });

  it('draws its unchecked box in a border a person can see', () => {
    render(<Checkbox aria-label='Accept' />);
    const cb = screen.getByRole('checkbox', { name: 'Accept' });
    // Unchecked, this border is the whole of what says the control is there:
    // the fill sits at 1.03:1 against the panel behind it. Measured in a
    // browser, `border-border` gave 1.26:1 in light and 1.39:1 in dark, and
    // WCAG 1.4.11 asks 3:1 of anything that identifies a control or its
    // state. `muted-foreground` measures 5.6:1 and 5.75:1 in light, 5.76:1
    // and 5.51:1 in dark — the smoke run holds those to the 3:1 bar in both
    // themes. `border-input` stays out: it is the opaque Switch-fill grey,
    // invisible as a dark-mode border.
    expect(cb.className).toContain('border-muted-foreground');
    expect(cb.className).not.toContain('border-input');
  });

  it('checked state uses the neutral bg-primary (no brand color)', () => {
    render(<Checkbox aria-label='Accept' defaultChecked />);
    const cb = screen.getByRole('checkbox', { name: 'Accept' });
    expect(cb.className).toContain('data-[state=checked]:bg-primary');
  });
});
