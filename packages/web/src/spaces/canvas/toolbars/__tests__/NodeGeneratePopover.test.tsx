import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NodeGeneratePopover } from '../NodeGeneratePopover';

describe('NodeGeneratePopover', () => {
  it('renders the Generate trigger', () => {
    render(<NodeGeneratePopover modality='text' />);
    expect(screen.getByTestId('node-generate-trigger')).toBeInTheDocument();
  });

  it('opens the popover on click and renders prompt + send', async () => {
    const user = userEvent.setup();
    render(<NodeGeneratePopover modality='image' />);
    await user.click(screen.getByTestId('node-generate-trigger'));
    expect(await screen.findByTestId('node-generate-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('node-generate-submit')).toBeInTheDocument();
  });

  it('submit is disabled while prompt is empty', async () => {
    const user = userEvent.setup();
    render(<NodeGeneratePopover modality='text' />);
    await user.click(screen.getByTestId('node-generate-trigger'));
    expect(
      (screen.getByTestId('node-generate-submit') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('typing + submit fires onGenerate with (prompt, model)', async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(<NodeGeneratePopover modality='image' onGenerate={onGenerate} />);
    await user.click(screen.getByTestId('node-generate-trigger'));
    await user.type(
      await screen.findByTestId('node-generate-prompt'),
      'red bird',
    );
    await user.click(screen.getByTestId('node-generate-submit'));
    expect(onGenerate).toHaveBeenCalledWith('red bird', 'sdxl');
  });
});
