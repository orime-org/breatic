import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../select';

// jsdom lacks ResizeObserver + hasPointerCapture used by Radix Select.
// Provide minimal stubs to keep tests focused on contract.
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ||= () => false;
  Element.prototype.releasePointerCapture ||= () => {};
  Element.prototype.scrollIntoView ||= () => {};
});

function setup(open: boolean) {
  return render(
    <Select open={open} defaultValue="a">
      <SelectTrigger data-testid="trigger">
        <SelectValue placeholder="Pick" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Option A</SelectItem>
        <SelectItem value="b">Option B</SelectItem>
      </SelectContent>
    </Select>,
  );
}

describe('Select', () => {
  it('renders the trigger as a button', () => {
    setup(false);
    const trigger = screen.getByTestId('trigger');
    expect(trigger.tagName).toBe('BUTTON');
  });

  it('trigger carries border-input + bg-transparent tokens', () => {
    setup(false);
    const trigger = screen.getByTestId('trigger');
    expect(trigger.className).toContain('border-input');
    expect(trigger.className).toContain('bg-transparent');
  });

  it('shows the currently selected value (defaultValue=a)', () => {
    setup(false);
    expect(screen.getByText('Option A')).toBeInTheDocument();
  });

  it('renders all options when open=true', () => {
    setup(true);
    expect(
      screen.getAllByText('Option A').length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Option B').length,
    ).toBeGreaterThan(0);
  });

  it('trigger merges custom className (tailwind-merge)', () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="x">X</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByTestId('trigger');
    // tailwind-merge: w-48 overrides default w-full.
    expect(trigger.className).toContain('w-48');
    expect(trigger.className).not.toContain('w-full');
  });
});
