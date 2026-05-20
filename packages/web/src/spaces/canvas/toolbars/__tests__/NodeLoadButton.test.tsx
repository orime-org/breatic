import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NodeLoadButton } from '@/spaces/canvas/toolbars/NodeLoadButton';

describe('NodeLoadButton', () => {
  it('renders the Load trigger', () => {
    render(<NodeLoadButton modality='image' />);
    expect(screen.getByTestId('node-load-trigger')).toBeInTheDocument();
  });

  it('hidden input has accept filter matching the modality', () => {
    render(<NodeLoadButton modality='audio' />);
    expect(
      screen.getByTestId('node-load-input').getAttribute('accept'),
    ).toBe('audio/*');
  });

  it('clicking the trigger forwards to the hidden input (no error)', async () => {
    const user = userEvent.setup();
    render(<NodeLoadButton modality='video' />);
    await user.click(screen.getByTestId('node-load-trigger'));
  });

  it('file change fires onLoad with the chosen File', () => {
    const onLoad = vi.fn();
    render(<NodeLoadButton modality='image' onLoad={onLoad} />);
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('node-load-input'), {
      target: { files: [file] },
    });
    expect(onLoad).toHaveBeenCalledWith(file);
  });
});
