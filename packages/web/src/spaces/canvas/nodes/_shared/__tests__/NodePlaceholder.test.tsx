import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NodePlaceholder } from '../NodePlaceholder';

describe('NodePlaceholder', () => {
  it('renders for text modality with default hint', () => {
    render(<NodePlaceholder modality='text' />);
    expect(screen.getByTestId('node-placeholder')).toHaveTextContent(
      /write or generate text/i,
    );
  });

  it('renders for image modality with default hint', () => {
    render(<NodePlaceholder modality='image' />);
    expect(screen.getByTestId('node-placeholder')).toHaveTextContent(
      /upload or generate an image/i,
    );
  });

  it('renders custom hint when provided', () => {
    render(<NodePlaceholder modality='audio' hint='Recording…' />);
    expect(screen.getByText('Recording…')).toBeInTheDocument();
  });

  it('clicking calls onActivate', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<NodePlaceholder modality='video' onActivate={onActivate} />);
    await user.click(screen.getByTestId('node-placeholder'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('exposes modality on data-attribute for e2e selectors', () => {
    render(<NodePlaceholder modality='audio' />);
    expect(
      screen.getByTestId('node-placeholder').getAttribute('data-modality'),
    ).toBe('audio');
  });
});
