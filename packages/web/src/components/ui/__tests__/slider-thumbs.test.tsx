import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { Slider } from '@web/components/ui/slider';

// inner#888 §7.4: a cut's range is one slider with a handle at each end.
describe('Slider thumbs', () => {
  it('draws one thumb for one value', () => {
    render(<Slider value={[3]} min={0} max={10} aria-label='x' />);
    expect(screen.getAllByRole('slider')).toHaveLength(1);
  });

  // A value that runs both ways fills from its neutral point, so an untouched one shows no fill.
  it('fills from the origin to the thumb when given one', () => {
    const { container, rerender } = render(<Slider value={[20]} min={-100} max={100} origin={0} aria-label='x' />);
    const fill = (): HTMLElement => container.querySelector<HTMLElement>('[data-slot="slider-origin-fill"]')!;
    expect(fill().style.left).toBe('50%');
    expect(fill().style.width).toBe('10%');
    rerender(<Slider value={[-40]} min={-100} max={100} origin={0} aria-label='x' />);
    expect(fill().style.left).toBe('30%');
    expect(fill().style.width).toBe('20%');
    rerender(<Slider value={[0]} min={-100} max={100} origin={0} aria-label='x' />);
    expect(fill().style.width).toBe('0%');
  });

  it('draws a thumb per value for a range', () => {
    render(<Slider value={[2, 6]} min={0} max={10} aria-label='x' />);
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });
});
