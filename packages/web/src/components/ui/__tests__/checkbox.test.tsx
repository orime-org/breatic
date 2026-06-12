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

  it('uses the visible form-control border token (border-border, not border-input)', () => {
    render(<Checkbox aria-label='Accept' />);
    const cb = screen.getByRole('checkbox', { name: 'Accept' });
    // border-input is the opaque Switch-fill grey, invisible as a dark-mode
    // border; form controls share Input's visible hairline (border-border).
    expect(cb.className).toContain('border-border');
    expect(cb.className).not.toContain('border-input');
  });

  it('checked state uses the neutral bg-primary (no brand color)', () => {
    render(<Checkbox aria-label='Accept' defaultChecked />);
    const cb = screen.getByRole('checkbox', { name: 'Accept' });
    expect(cb.className).toContain('data-[state=checked]:bg-primary');
  });
});
