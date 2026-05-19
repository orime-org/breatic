import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrushControls } from '../BrushControls';

function setup(overrides: Partial<Parameters<typeof BrushControls>[0]> = {}) {
  const handlers = {
    onToolChange: vi.fn(),
    onBrushSizeChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onUndo: vi.fn(),
  };
  render(
    <BrushControls
      tool='brush'
      brushSize={30}
      opacity={0.8}
      canUndo
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('BrushControls', () => {
  it('marks the active tool with aria-pressed=true', () => {
    setup({ tool: 'erase' });
    expect(
      screen.getByTestId('brush-tool-erase').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('clicking brush fires onToolChange("brush")', async () => {
    const user = userEvent.setup();
    const { onToolChange } = setup({ tool: 'erase' });
    await user.click(screen.getByTestId('brush-tool-brush'));
    expect(onToolChange).toHaveBeenCalledWith('brush');
  });

  it('brush size slider reflects current value', () => {
    setup({ brushSize: 42 });
    expect(
      (screen.getByTestId('brush-size') as HTMLInputElement).value,
    ).toBe('42');
  });

  it('opacity slider maps 0..1 -> 0..100', () => {
    setup({ opacity: 0.3 });
    expect(
      (screen.getByTestId('brush-opacity') as HTMLInputElement).value,
    ).toBe('30');
  });

  it('Undo button is disabled when canUndo=false', () => {
    setup({ canUndo: false });
    expect(
      (screen.getByTestId('brush-undo') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
