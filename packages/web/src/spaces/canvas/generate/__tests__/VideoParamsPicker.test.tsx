// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import { VideoParamsPicker } from '@web/spaces/canvas/generate/VideoParamsPicker';

/**
 * Builds a video model carrying the given params.
 * @param params - The model's param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'veo-3.1',
    display_name: 'VEO 3.1',
    modality: 'video',
    mode: 't2v',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 88,
    generation_time: 120,
    params,
    providers: [],
    sourcesByMode: { t2v: [] },
  };
}

const RATIO: ParamDescriptor = {
  description: '',
  values: ['16:9', '9:16', '1:1'],
  default: '16:9',
};
const RESOLUTION: ParamDescriptor = {
  description: '',
  values: ['480p', '720p', '1080p'],
  default: '720p',
};
const DURATION_LIST: ParamDescriptor = {
  description: '',
  values: [4, 6, 8],
  default: 8,
};
const AUDIO: ParamDescriptor = {
  description: '',
  values: [true, false],
  default: true,
};
const FULL = model({
  aspect_ratio: RATIO,
  resolution: RESOLUTION,
  duration: DURATION_LIST,
  generate_audio: AUDIO,
});

describe('VideoParamsPicker', () => {
  it('shows ratio, resolution and duration on the trigger', () => {
    render(
      <VideoParamsPicker
        model={FULL}
        value={{ aspect_ratio: '16:9', resolution: '720p', duration: 6 }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('generate-video-params-trigger')).toHaveTextContent(
      '16:9 · 720p · 6s',
    );
  });

  it('leaves out the parts the model does not declare', () => {
    // seedance-2.0 declares no resolution, kling-o3-pro no resolution either —
    // the trigger must read as the model's own params, not as a fixed shape
    // with blanks in it.
    const noResolution = model({ aspect_ratio: RATIO, duration: DURATION_LIST });
    render(
      <VideoParamsPicker
        model={noResolution}
        value={{ aspect_ratio: '9:16', resolution: '720p', duration: 4 }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('generate-video-params-trigger')).toHaveTextContent(
      '9:16 · 4s',
    );
  });

  it('offers every group the model declares, current value marked', () => {
    render(
      <VideoParamsPicker
        model={FULL}
        value={{ aspect_ratio: '16:9', resolution: '720p', duration: 6 }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    expect(screen.getByTestId('generate-video-ratio-option-9:16')).toBeVisible();
    expect(
      screen.getByTestId('generate-video-resolution-option-1080p'),
    ).toBeVisible();
    expect(screen.getByTestId('generate-video-duration-option-4')).toBeVisible();
    expect(screen.getByTestId('generate-video-audio-toggle')).toBeVisible();
    expect(
      screen.getByTestId('generate-video-resolution-option-720p'),
    ).toHaveAttribute('aria-current', 'true');
  });

  it('hides a group the model does not declare', () => {
    // Not every video model can generate sound — the group disappears rather
    // than offering a switch the model will ignore.
    const silent = model({ aspect_ratio: RATIO, duration: DURATION_LIST });
    render(
      <VideoParamsPicker model={silent} value={{}} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    expect(screen.queryByTestId('generate-video-audio-toggle')).toBeNull();
    expect(
      screen.queryByTestId('generate-video-resolution-option-720p'),
    ).toBeNull();
    expect(screen.getByTestId('generate-video-duration-option-6')).toBeVisible();
  });

  it('picking a ratio reports the aspect_ratio', () => {
    const onChange = vi.fn();
    render(
      <VideoParamsPicker model={FULL} value={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(screen.getByTestId('generate-video-ratio-option-1:1'));
    expect(onChange).toHaveBeenCalledWith({ aspect_ratio: '1:1' });
  });

  it('picking a duration reports a NUMBER, the type the provider takes', () => {
    // The catalog states duration numerically; reporting "6" would put a
    // string in the payload where the provider expects 6.
    const onChange = vi.fn();
    render(
      <VideoParamsPicker model={FULL} value={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(screen.getByTestId('generate-video-duration-option-6'));
    expect(onChange).toHaveBeenCalledWith({ duration: 6 });
  });

  it('expands a range-shaped duration into one option per second', () => {
    // `kling-o3-pro` states 3 to 15 with no values list, and it is the only
    // text-to-video model that does. Without this the duration group would
    // vanish for it entirely and the user could not pick a duration.
    const ranged = model({
      aspect_ratio: RATIO,
      duration: { description: '', min: 4, max: 6, default: 5 },
    });
    const onChange = vi.fn();
    render(
      <VideoParamsPicker model={ranged} value={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    expect(screen.getByTestId('generate-video-duration-option-4')).toBeVisible();
    expect(screen.getByTestId('generate-video-duration-option-5')).toBeVisible();
    expect(screen.getByTestId('generate-video-duration-option-6')).toBeVisible();
    fireEvent.click(screen.getByTestId('generate-video-duration-option-5'));
    expect(onChange).toHaveBeenCalledWith({ duration: 5 });
  });

  it('toggling audio reports a boolean', () => {
    const onChange = vi.fn();
    render(
      <VideoParamsPicker
        model={FULL}
        value={{ generate_audio: true }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(screen.getByTestId('generate-video-audio-toggle'));
    expect(onChange).toHaveBeenCalledWith({ generate_audio: false });
  });
});
