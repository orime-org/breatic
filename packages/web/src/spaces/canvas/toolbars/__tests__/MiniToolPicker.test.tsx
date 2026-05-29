import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MiniToolPicker } from '@web/spaces/canvas/toolbars/MiniToolPicker';

describe('MiniToolPicker', () => {
  it('renders the Mini-tool trigger', () => {
    render(<MiniToolPicker modality='image' />);
    expect(screen.getByTestId('mini-tool-trigger')).toBeInTheDocument();
  });

  it('opens the popover and lists modality-scoped tools', async () => {
    const user = userEvent.setup();
    render(<MiniToolPicker modality='image' />);
    await user.click(screen.getByTestId('mini-tool-trigger'));
    expect(await screen.findByTestId('mini-tool-inpaint')).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-remove-bg')).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-upscale')).toBeInTheDocument();
  });

  it('clicking a tool fires onPick with its id', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<MiniToolPicker modality='text' onPick={onPick} />);
    await user.click(screen.getByTestId('mini-tool-trigger'));
    await user.click(await screen.findByTestId('mini-tool-polish'));
    expect(onPick).toHaveBeenCalledWith('polish');
  });
});
