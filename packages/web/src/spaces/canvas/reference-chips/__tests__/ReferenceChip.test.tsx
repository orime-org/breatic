import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReferenceChip } from '@/spaces/canvas/reference-chips/ReferenceChip';

describe('ReferenceChip', () => {
  it('renders the label and the modality attribute', () => {
    render(<ReferenceChip modality='image' label='cover.jpg' />);
    const chip = screen.getByTestId('reference-chip');
    expect(chip).toHaveTextContent('cover.jpg');
    expect(chip.getAttribute('data-modality')).toBe('image');
  });

  it('omits the remove button when no onRemove is given', () => {
    render(<ReferenceChip modality='text' label='snippet' />);
    expect(
      screen.queryByTestId('reference-chip-remove'),
    ).not.toBeInTheDocument();
  });

  it('renders the remove button when onRemove is given', () => {
    render(
      <ReferenceChip modality='audio' label='clip' onRemove={() => {}} />,
    );
    expect(screen.getByTestId('reference-chip-remove')).toBeInTheDocument();
  });

  it('clicking remove fires onRemove', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ReferenceChip modality='video' label='intro' onRemove={onRemove} />,
    );
    await user.click(screen.getByTestId('reference-chip-remove'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
