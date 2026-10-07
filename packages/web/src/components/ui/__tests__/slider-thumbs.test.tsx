import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { Slider } from '@web/components/ui/slider';

// inner#888 §7.4: a cut's range is one slider with a handle at each end.
describe('Slider thumbs', () => {
  it('draws one thumb for one value', () => {
    render(<Slider value={[3]} min={0} max={10} aria-label='x' />);
    expect(screen.getAllByRole('slider')).toHaveLength(1);
  });

  it('draws a thumb per value for a range', () => {
    render(<Slider value={[2, 6]} min={0} max={10} aria-label='x' />);
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });
});
