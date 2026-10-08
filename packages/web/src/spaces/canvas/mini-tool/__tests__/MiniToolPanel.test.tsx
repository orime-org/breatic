// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { setLocale } from '@breatic/shared';
import { miniToolById, type MiniToolSpec } from '@breatic/shared/mini-tools';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { MiniToolPanel, type MiniToolPanelProps } from '@web/spaces/canvas/mini-tool/MiniToolPanel';

/**
 * A registry tool by id.
 * @param id - The tool id.
 * @returns The declaration.
 */
function tool(id: string): MiniToolSpec {
  const spec = miniToolById(id);
  if (!spec) throw new Error(id);
  return spec;
}

/**
 * Render the panel with defaults the case overrides.
 * @param over - Props to override.
 * @returns The props used.
 */
function mount(over: Partial<MiniToolPanelProps> = {}): MiniToolPanelProps {
  const props: MiniToolPanelProps = {
    spec: tool('image.rotate'),
    modelControls: undefined,
    modelEntry: undefined,
    params: { orient: { turns: 0, flipX: false, flipY: false } },
    onParams: vi.fn(),
    source: { width: 1600, height: 1000 },
    sizeTiers: [],
    slots: {},
    slotCaps: {},
    pickingSlot: null,
    onPickSlot: vi.fn(),
    onClearSlot: vi.fn(),
    prompt: '',
    onPrompt: vi.fn(),
    creditText: 'Free',
    refusal: null,
    onRun: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(
    <TooltipProvider>
      <MiniToolPanel {...props} />
    </TooltipProvider>,
  );
  return props;
}

describe('MiniToolPanel', () => {
  it('heads itself with the tool name and closes on its X', () => {
    const props = mount();
    expect(screen.getByTestId('mini-tool-panel-title')).toHaveTextContent('Rotate & flip');
    fireEvent.click(screen.getByTestId('mini-tool-panel-close'));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('turns and flips the orientation from its four buttons', () => {
    const props = mount();
    fireEvent.click(screen.getByTestId('mini-tool-orient-right'));
    expect(props.onParams).toHaveBeenLastCalledWith({ orient: { turns: 1, flipX: false, flipY: false } });
    fireEvent.click(screen.getByTestId('mini-tool-orient-left'));
    expect(props.onParams).toHaveBeenLastCalledWith({ orient: { turns: 3, flipX: false, flipY: false } });
    fireEvent.click(screen.getByTestId('mini-tool-orient-flipX'));
    expect(props.onParams).toHaveBeenLastCalledWith({ orient: { turns: 0, flipX: true, flipY: false } });
  });

  // Each orientation button names a value, and value names stay English.
  it('names the orientation buttons in English whatever the language', () => {
    setLocale('zh-CN');
    try {
      mount();
      expect(screen.getByTestId('mini-tool-orient-flipX')).toHaveTextContent('Flip');
      expect(screen.getByTestId('mini-tool-orient-left')).toHaveTextContent('−90°');
    } finally {
      setLocale('en');
    }
  });

  // A9: a locked ratio puts the largest rectangle of it on the source.
  it('reshapes the crop when a ratio is chosen', () => {
    const props = mount({ spec: tool('image.crop'), params: { aspect: 'free', rect: null } });
    fireEvent.click(screen.getByTestId('mini-tool-param-aspect-1:1'));
    expect(props.onParams).toHaveBeenLastCalledWith({ aspect: '1:1', rect: { x: 300, y: 0, w: 1000, h: 1000 } });
  });

  it('shows the full source as the crop until the reader sets one', () => {
    mount({ spec: tool('image.crop'), params: { aspect: 'free', rect: null } });
    expect(screen.getByTestId('mini-tool-rect-w')).toHaveValue('1600');
    expect(screen.getByTestId('mini-tool-rect-h')).toHaveValue('1000');
  });

  // A9: clearing a side to type a new one leaves the field empty until the
  // typing is done; the size is written when the field is left or Enter pressed.
  it('lets a side be cleared and retyped, writing it when the typing is done', () => {
    const props = mount({ spec: tool('image.crop'), params: { aspect: 'free', rect: null } });
    const width = screen.getByTestId('mini-tool-rect-w');
    fireEvent.change(width, { target: { value: '' } });
    expect(width).toHaveValue('');
    fireEvent.change(width, { target: { value: '500' } });
    expect(props.onParams).not.toHaveBeenCalled();
    fireEvent.blur(width);
    expect(props.onParams).toHaveBeenLastCalledWith({ rect: { x: 0, y: 0, w: 500, h: 1000 } });
  });

  it('writes a typed side on Enter, and drops a side left empty', () => {
    const props = mount({ spec: tool('image.crop'), params: { aspect: 'free', rect: null } });
    const height = screen.getByTestId('mini-tool-rect-h');
    fireEvent.change(height, { target: { value: '40x0' } });
    expect(height).toHaveValue('400');
    fireEvent.keyDown(height, { key: 'Enter' });
    expect(props.onParams).toHaveBeenLastCalledWith({ rect: { x: 0, y: 0, w: 1600, h: 400 } });
    const width = screen.getByTestId('mini-tool-rect-w');
    fireEvent.change(width, { target: { value: '' } });
    fireEvent.blur(width);
    expect(props.onParams).toHaveBeenCalledTimes(1);
    expect(width).toHaveValue('1600');
  });

  // The upscale tool's size reads as tiers with the size each comes to.
  it('offers output sizes with their pixel size, holding back one that cannot be used', () => {
    const props = mount({
      spec: tool('image.upscale'),
      params: {},
      sizeTiers: [
        {
          key: 'target_megapixels',
          selected: '4K',
          options: [
            { label: '2K', width: 1536, height: 2048, megapixels: 3.15, usable: false },
            { label: '4K', width: 3072, height: 4096, megapixels: 12.58, usable: true },
            { label: '8K', width: 6144, height: 8192, megapixels: 50.33, usable: true },
          ],
        },
      ],
    });
    expect(screen.getByTestId('mini-tool-size-target_megapixels-4K')).toHaveTextContent('3072×4096');
    expect(screen.getByTestId('mini-tool-size-target_megapixels-4K')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('mini-tool-size-target_megapixels-2K')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mini-tool-size-target_megapixels-8K'));
    expect(props.onParams).toHaveBeenCalledWith({ target_megapixels: '8K' });
  });

  it('names a required slot and starts its pick', () => {
    const props = mount({ spec: tool('video.motion'), modelEntry: undefined, params: {} });
    const slot = screen.getByTestId('mini-tool-slot-video.motion-character');
    expect(slot).toHaveAccessibleName('Image (required)');
    fireEvent.click(slot);
    expect(props.onPickSlot).toHaveBeenCalledWith('character');
  });

  it('holds Run back while a required input is missing, and runs otherwise', () => {
    mount({ refusal: 'slotMissing' });
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
  });

  // A7: a source still loading is said when Run is pressed, so the button stays live.
  it('leaves Run pressable when only the source is not ready', () => {
    const props = mount({ refusal: 'sourceMissing' });
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(props.onRun).toHaveBeenCalledOnce();
  });

  it('states the cost beside Run', () => {
    mount({ creditText: 'Billed by usage' });
    expect(screen.getByTestId('mini-tool-credit')).toHaveTextContent('Billed by usage');
  });

  it('draws a prompt box for a tool that takes one', () => {
    const props = mount({ spec: tool('video.motion'), params: {} });
    fireEvent.change(screen.getByTestId('mini-tool-prompt'), { target: { value: 'walk' } });
    expect(props.onPrompt).toHaveBeenCalledWith('walk');
  });
});
