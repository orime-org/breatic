// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import { RatioResolutionPicker } from '@web/spaces/canvas/generate/RatioResolutionPicker';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import { expectAriaCurrentChosenFill } from '@web/test-utils/selection-fill';

/**
 * Builds an image model with the given params for the picker tests.
 * @param params - The model's param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'image',
    mode: 'text-to-image',
    description: '',
    guide: '',
    tier: 'recommended',
    generation_time: 30,
    takes_prompt: true,
    params,
    providers: [],
  };
}

const RATIO: ParamDescriptor = {
  description: 'Aspect ratio',
  values: ['1:1', '16:9', '4:3'],
  default: '1:1',
};
const RESOLUTION: ParamDescriptor = {
  description: 'Resolution',
  values: ['1K', '2K'],
  default: '1K',
};
const FULL = model({ aspect_ratio: RATIO, resolution: RESOLUTION });

describe('RatioResolutionPicker — ratio + resolution from the current model params', () => {
  it('shows the current resolution · ratio on the trigger, in the popover\'s order', () => {
    render(
      <RatioResolutionPicker mode='t2i'
        model={FULL}
        value={{ aspect_ratio: '16:9', resolution: '2K' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('generate-ratio-trigger')).toHaveTextContent(
      '2K · 16:9',
    );
  });

  it('says on the trigger what each of the model\'s own controls stands on', () => {
    // User 2026-09-29: the pill shows every value the reader would send.
    const own = model({
      aspect_ratio: { ...RATIO, values: ['auto', '1:1'], default: 'auto' },
      resolution: RESOLUTION,
      quality: { description: '', label: 'Quality', values: ['low', 'max'], default: 'max', fill: 'panel' },
    });
    render(<RatioResolutionPicker mode='t2i' model={own} value={resolveParamsForModel(own, { aspect_ratio: 'auto', resolution: '1K' })} onChange={() => {}} />);
    expect(screen.getByTestId('generate-ratio-trigger')).toHaveTextContent('1K · Auto · Max');
  });

  it('caps the pill at 150px, like the video and audio params pills', () => {
    render(<RatioResolutionPicker mode='t2i' model={FULL} value={{ aspect_ratio: '16:9', resolution: '2K' }} onChange={() => {}} />);
    expect(screen.getByTestId('generate-ratio-trigger').className).toContain('max-w-[150px]');
  });

  it('picking a ratio fires onChange with the aspect_ratio', () => {
    const onChange = vi.fn();
    render(
      <RatioResolutionPicker mode='t2i'
        model={FULL}
        value={{ aspect_ratio: '1:1', resolution: '1K' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    fireEvent.click(screen.getByTestId('generate-ratio-option-16:9'));
    expect(onChange).toHaveBeenCalledWith({ aspect_ratio: '16:9' });
  });

  it('fills the current ratio past the fill the others take under the pointer', () => {
    render(
      <RatioResolutionPicker mode='t2i'
        model={FULL}
        value={{ aspect_ratio: '1:1', resolution: '1K' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    const chosen = screen.getByTestId('generate-ratio-option-1:1');
    expect(chosen).toHaveAttribute('aria-current', 'true');
    expectAriaCurrentChosenFill(chosen);
    expect(screen.getByTestId('generate-ratio-option-16:9')).toHaveAttribute(
      'aria-current',
      'false',
    );
  });

  // Malformed-catalog robustness (non-array param values) is now enforced ONCE
  // at the API boundary — see sanitizeModelCatalog + model-catalog.schema.test.ts.
  // The picker consumes the sanitized, trusted ModelEntry, so that
  // impossible-after-boundary state is no longer re-tested here.

  it('picking a resolution fires onChange with the resolution', () => {
    const onChange = vi.fn();
    render(
      <RatioResolutionPicker mode='t2i'
        model={FULL}
        value={{ aspect_ratio: '1:1', resolution: '1K' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    fireEvent.click(screen.getByTestId('generate-resolution-option-2K'));
    expect(onChange).toHaveBeenCalledWith({ resolution: '2K' });
  });

  it('omits the ratio section for a model with no aspect_ratio param', () => {
    render(
      <RatioResolutionPicker mode='t2i'
        model={model({ resolution: RESOLUTION })}
        value={{ resolution: '2K' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect(screen.queryByTestId('generate-ratio-option-16:9')).toBeNull();
    expect(screen.getByTestId('generate-resolution-option-1K')).toBeInTheDocument();
  });
});

describe('RatioResolutionPicker — the camera row (#2254)', () => {
  const CAMERA = model({
    aspect_ratio: RATIO,
    resolution: RESOLUTION,
    enable_camera: { description: '', values: [true, false], default: false, fill: 'panel' },
    camera: { description: '', values: ['Canon EOS R5', 'Sony A7'], default: 'Canon EOS R5', fill: 'panel' },
    lens: { description: '', values: ['Zeiss', 'Leica'], default: 'Zeiss', fill: 'panel' },
    focal_length: { description: '', values: [35, 50, 85], default: 50, fill: 'panel' },
    aperture: { description: '', values: ['f/1.4', 'f/2.8'], default: 'f/2.8', fill: 'panel' },
  });
  const SET = { aspect_ratio: '1:1', resolution: '1K', camera: 'Canon EOS R5', lens: 'Zeiss', focal_length: 50, aperture: 'f/2.8' };

  it('draws no camera row for a model without the camera', () => {
    render(<RatioResolutionPicker mode='t2i' model={FULL} value={{ aspect_ratio: '1:1', resolution: '1K' }} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect(screen.queryByTestId('generate-camera-row')).toBeNull();
  });

  it('reads Off on the row while the camera is off', () => {
    render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: false }} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    const row = screen.getByTestId('generate-camera-row');
    expect(row).toHaveTextContent('Camera');
    expect(row).toHaveTextContent('Off');
  });

  it('lists the four settings on the row while the camera is on', () => {
    render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: true }} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect(screen.getByTestId('generate-camera-row')).toHaveTextContent('Canon EOS R5 · Zeiss · 50 mm · f/2.8');
  });

  it('opens the camera panel from the row and closes it on a second click', () => {
    render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: false }} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    const row = screen.getByTestId('generate-camera-row');
    expect(screen.queryByTestId('generate-camera-panel')).toBeNull();
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(screen.getByTestId('generate-camera-panel')).toBeInTheDocument();
    expect(screen.getByTestId('generate-camera-toggle')).toBeInTheDocument();
    expect(screen.getByLabelText('Aperture ▼')).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(row);
    expect(screen.queryByTestId('generate-camera-panel')).toBeNull();
  });

  it('closes the camera panel with the popover, so it opens folded next time', () => {
    render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: false }} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    fireEvent.click(screen.getByTestId('generate-camera-row'));
    fireEvent.keyDown(screen.getByTestId('generate-camera-panel'), { key: 'Escape' });
    expect(screen.queryByTestId('generate-camera-row')).toBeNull();
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect(screen.getByTestId('generate-camera-row')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('generate-camera-panel')).toBeNull();
  });

  it('writes the switch and the wheels back from the panel', () => {
    const onChange = vi.fn();
    render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: false }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    fireEvent.click(screen.getByTestId('generate-camera-row'));
    fireEvent.click(screen.getByTestId('generate-camera-toggle'));
    expect(onChange).toHaveBeenCalledWith({ enable_camera: true });
    fireEvent.click(screen.getByLabelText('Focal length ▼'));
    expect(onChange).toHaveBeenCalledWith({ focal_length: 85 });
  });

  it('puts the camera row in the same section as the model\'s own switches', () => {
    const own = model({
      ...CAMERA.params,
      enable_web_search: { description: '', label: 'Web search', values: [true, false], default: false, fill: 'panel' },
    });
    render(<RatioResolutionPicker mode='t2i' model={own} value={{ ...SET, enable_camera: false }} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect(screen.getByTestId('generate-camera-row').parentElement!.className).not.toContain('border-t');
  });

  it('sets the camera row off with a line when nothing of the model\'s own sits above it', () => {
    render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: false }} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect(screen.getByTestId('generate-camera-row').parentElement!.className).toContain('border-t');
  });

  it('opens the panel on the left when a narrow window caps it at 88vw and only the left has room', () => {
    // 500px window: the panel is 440px wide plus the 8px gap. The popover's left
    // edge at 460 leaves room there and none on the right; a fixed 520px panel
    // would fit on neither side and stay right.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 460, right: 460, top: 0, bottom: 0, width: 0, height: 0, x: 460, y: 0, toJSON: () => ({}),
    } as DOMRect);
    vi.stubGlobal('innerWidth', 500);
    try {
      render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: false }} onChange={() => {}} />);
      fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
      fireEvent.click(screen.getByTestId('generate-camera-row'));
      expect(screen.getByTestId('generate-camera-panel')).toHaveAttribute('data-side', 'left');
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('adds Camera to the pill only while the camera is on', () => {
    const { rerender } = render(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: true }} onChange={() => {}} />);
    expect(screen.getByTestId('generate-ratio-trigger')).toHaveTextContent('1K · 1:1 · Camera');
    rerender(<RatioResolutionPicker mode='t2i' model={CAMERA} value={{ ...SET, enable_camera: false }} onChange={() => {}} />);
    expect(screen.getByTestId('generate-ratio-trigger')).not.toHaveTextContent('Camera');
  });
});
