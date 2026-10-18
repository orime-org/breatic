// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ADJUST_RANGES, defaultAdjustValue, setLocale } from '@breatic/shared';
import { miniToolById, type MiniToolSpec } from '@breatic/shared/mini-tools';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { MiniToolPanel, type MiniToolPanelProps } from '@web/spaces/canvas/mini-tool/MiniToolPanel';
import { canvasSessions } from '@web/stores/canvas-session';

afterEach(() => canvasSessions.clear());

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
      // The two flips name their axis, so the reader tells them apart without the icon.
      expect(screen.getByTestId('mini-tool-orient-flipX').textContent).toBe('Flip H');
      expect(screen.getByTestId('mini-tool-orient-flipY').textContent).toBe('Flip V');
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
    expect(screen.getByTestId('mini-tool-size-target_megapixels-4K')).toHaveTextContent('≈3072×4096');
    expect(screen.getByTestId('mini-tool-size-target_megapixels-4K')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('mini-tool-size-target_megapixels-2K')).toBeDisabled();
    // The pixel size is a note under the tier name: it stays muted on the selected tier too.
    expect(screen.getByText('≈3072×4096')).toHaveClass('text-muted-foreground');
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

  // The prompt is the tool's main input: it comes straight after the slots, before the params.
  it('puts the prompt before the params', () => {
    mount({
      spec: tool('video.motion'),
      params: {},
      sizeTiers: [{ key: 'target_megapixels', selected: '4K', options: [{ label: '4K', width: 1, height: 1, megapixels: 1, usable: true }] }],
    });
    const prompt = screen.getByTestId('mini-tool-prompt');
    const slot = screen.getByTestId('mini-tool-slot-video.motion-character');
    const param = screen.getByTestId('mini-tool-size-target_megapixels-4K');
    expect(slot.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prompt.compareDocumentPosition(param) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('the expand ratios', () => {
    /**
     * Mount the expand panel.
     * @param fits - Which ratios fit under the cap.
     * @returns The props.
     */
    function mountExpand(fits: (ratio: string) => boolean = () => true): MiniToolPanelProps {
      return mount({
        spec: tool('image.expand'),
        params: {},
        expand: { ratio: '1:1', fits, onRatio: vi.fn() },
      });
    }

    it('offers Free and the seven fixed ratios, marking the one in use', () => {
      mountExpand();
      const ids = ['free', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];
      for (const id of ids) expect(screen.getByTestId(`mini-tool-expand-ratio-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId('mini-tool-expand-ratio-1:1')).toHaveAttribute('aria-current', 'true');
      expect(screen.getByTestId('mini-tool-expand-ratio-free')).toHaveTextContent('Free');
    });

    it('sets a ratio when it is pressed', () => {
      const props = mountExpand();
      fireEvent.click(screen.getByTestId('mini-tool-expand-ratio-16:9'));
      expect(props.expand?.onRatio).toHaveBeenCalledWith('16:9');
    });

    // The draft's export, read from the session as the frame and the drawing
    // controls read it; a press of an earlier opening still waiting holds only Run.
    it('takes no ratio while the draft is exporting', () => {
      const session = canvasSessions.of('');
      session.getState().openMiniTool('n1', 'image.expand', { sourceContent: 'a.png', params: {} });
      session.getState().setMiniToolExporting(true, session.getState().panelSession);
      const props = mountExpand();
      const button = screen.getByTestId('mini-tool-expand-ratio-1:1');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(props.expand?.onRatio).not.toHaveBeenCalled();
    });

    it('takes a ratio while only Run waits on an earlier press', () => {
      const props = mount({
        spec: tool('image.expand'),
        params: {},
        refusal: 'exporting',
        expand: { ratio: 'free', fits: () => true, onRatio: vi.fn() },
      });
      fireEvent.click(screen.getByTestId('mini-tool-expand-ratio-1:1'));
      expect(props.expand?.onRatio).toHaveBeenCalledWith('1:1');
    });

    it('holds back a ratio too large for the model', () => {
      const props = mountExpand((ratio) => ratio !== '9:16');
      const button = screen.getByTestId('mini-tool-expand-ratio-9:16');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(props.expand?.onRatio).not.toHaveBeenCalled();
    });
  });

  describe.each(['video.adjust', 'image.adjust'])('the %s sliders', (id) => {
    const source = { width: 1600, height: 1000, duration: 8 };

    it('runs each channel over its declared range, filled from zero', () => {
      mount({ spec: tool(id), params: {}, source });
      for (const field of Object.keys(ADJUST_RANGES) as (keyof typeof ADJUST_RANGES)[]) {
        const { min, max } = ADJUST_RANGES[field];
        const slider = screen.getByTestId(`mini-tool-adjust-${field}-slider`);
        const thumb = slider.querySelector('[role="slider"]')!;
        expect(thumb.getAttribute('aria-valuemin'), field).toBe(String(min));
        expect(thumb.getAttribute('aria-valuemax'), field).toBe(String(max));
        const fill = slider.querySelector<HTMLElement>('[data-slot="slider-origin-fill"]')!;
        expect(fill.style.left, field).toBe(min === 0 ? '0%' : '50%');
        expect(fill.style.width, field).toBe('0%');
      }
    });

    // A2: the node's picture follows the slider while it moves, not on release.
    it('hands each step on while the slider is still moving', () => {
      const props = mount({ spec: tool(id), params: {}, source });
      const thumb = screen.getByTestId('mini-tool-adjust-exposure-slider').querySelector('[role="slider"]')!;
      fireEvent.keyDown(thumb, { key: 'ArrowRight', repeat: true });
      expect(props.onParams).toHaveBeenLastCalledWith({ value: { ...defaultAdjustValue, exposure: 1 } });
    });

    // Lightroom and Camera Raw split the same channels into titled groups.
    it('lays the sliders out in Light, Color, Detail and Effects, every channel once', () => {
      mount({ spec: tool(id), params: {}, source });
      const groups = screen.getAllByTestId(/^mini-tool-adjust-group-/);
      expect(groups.map((group) => group.dataset.testid)).toEqual([
        'mini-tool-adjust-group-light',
        'mini-tool-adjust-group-color',
        'mini-tool-adjust-group-detail',
        'mini-tool-adjust-group-effects',
      ]);
      const fields = groups.map((group) =>
        Array.from(group.querySelectorAll('[data-testid$="-slider"]'), (el) => el.getAttribute('data-testid')!.replace(/^mini-tool-adjust-|-slider$/g, '')),
      );
      expect(fields).toEqual([
        ['exposure', 'highlights', 'shadows', 'contrast'],
        ['saturation', 'vibrance', 'temperature', 'tint', 'hue'],
        ['sharpness', 'noiseReduction', 'clarity'],
        ['vignette', 'grain', 'fade'],
      ]);
      expect(fields.flat().sort()).toEqual(Object.keys(defaultAdjustValue).sort());
      expect(groups.map((group) => group.querySelector('h3')?.textContent)).toEqual(['Light', 'Color', 'Detail', 'Effects']);
    });

    // Reset sits in the footer beside the credit, so it takes no row of its own.
    it('keeps Reset in the footer beside the credit', () => {
      mount({ spec: tool(id), params: {}, source });
      expect(screen.getByTestId('mini-tool-credit').parentElement).toContainElement(screen.getByTestId('mini-tool-adjust-reset'));
    });

    it('puts every slider back to zero from Reset', () => {
      const props = mount({ spec: tool(id), params: { value: { ...defaultAdjustValue, exposure: 40 } }, source });
      fireEvent.click(screen.getByTestId('mini-tool-adjust-reset'));
      expect(props.onParams).toHaveBeenLastCalledWith({ value: defaultAdjustValue });
    });
  });

  // The cut's band shows what stays: the cut-away ends dimmed, the kept span framed.
  it('draws the kept span of a cut on a band', () => {
    mount({ spec: tool('video.cut'), params: { range: { start: 2, end: 6 } }, source: { width: 1280, height: 720, duration: 8 } });
    const band = screen.getByTestId('mini-tool-range-band');
    const part = (name: string): HTMLElement => band.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
    expect(part('before').style.width).toBe('25%');
    expect(part('after').style.left).toBe('75%');
    expect(part('kept').style.left).toBe('25%');
    expect(part('kept').style.width).toBe('50%');
  });

  // The cut's band is a filmstrip of the source, so the reader sees what each moment shows.
  it('lays the source out as a filmstrip on the cut band', () => {
    mount({
      spec: tool('video.cut'),
      params: { range: { start: 2, end: 6 } },
      source: { width: 1280, height: 720, duration: 8, url: 'https://cdn/v.mp4' },
    });
    expect(screen.getByTestId('mini-tool-range-band').querySelector('[data-testid="mini-tool-filmstrip"]')).not.toBeNull();
  });

  it('shows no Reset for a tool without sliders to clear', () => {
    mount({ spec: tool('image.crop'), params: {}, source: { width: 1600, height: 1000 } });
    expect(screen.queryByTestId('mini-tool-adjust-reset')).toBeNull();
  });

  it('draws a prompt box for a tool that takes one', () => {
    const props = mount({ spec: tool('video.motion'), params: {} });
    fireEvent.change(screen.getByTestId('mini-tool-prompt'), { target: { value: 'walk' } });
    expect(props.onPrompt).toHaveBeenCalledWith('walk');
  });
});

describe('MiniToolPanel grid tile picking', () => {
  it('counts the picked tiles and offers to pick none while all are picked', () => {
    const props = mount({ spec: tool('image.grid'), params: { rows: 3, cols: 3, skip: [] } });
    expect(screen.getByTestId('mini-tool-grid-picked')).toHaveTextContent('9 / 9 selected');
    fireEvent.click(screen.getByTestId('mini-tool-grid-pick-all'));
    expect(screen.getByTestId('mini-tool-grid-pick-all')).toHaveTextContent('Select none');
    expect(props.onParams).toHaveBeenCalledWith({ skip: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
  });

  it('offers to pick all while some tile is left out', () => {
    const props = mount({ spec: tool('image.grid'), params: { rows: 2, cols: 2, skip: [1, 3] } });
    expect(screen.getByTestId('mini-tool-grid-picked')).toHaveTextContent('2 / 4 selected');
    expect(screen.getByTestId('mini-tool-grid-pick-all')).toHaveTextContent('Select all');
    fireEvent.click(screen.getByTestId('mini-tool-grid-pick-all'));
    expect(props.onParams).toHaveBeenCalledWith({ skip: [] });
  });
});

