// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    takes_prompt: true,
    params,
    providers: [],
    sourcesByMode: { t2v: [] },
    sourceRuleByMode: { t2v: 'all_of' as const },
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
        params={{ aspect_ratio: '16:9', resolution: '720p', duration: 6 }}
        slots={[]}
        slotUrls={{}}
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
        params={{ aspect_ratio: '9:16', resolution: '720p', duration: 4 }}
        slots={[]}
        slotUrls={{}}
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
        params={{ aspect_ratio: '16:9', resolution: '720p', duration: 6 }}
        slots={[]}
        slotUrls={{}}
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
      <VideoParamsPicker model={silent} params={{}} slots={[]} slotUrls={{}} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    expect(screen.queryByTestId('generate-video-audio-toggle')).toBeNull();
    expect(
      screen.queryByTestId('generate-video-resolution-option-720p'),
    ).toBeNull();
    expect(screen.getByTestId('generate-video-duration-option-6')).toBeVisible();
  });

  it('leaves no bottom margin under the last group in the popover', () => {
    // `wan-2.2-animate` declares only `resolution`, so that group is the last
    // thing the popover renders. A margin under it shows as 24px of room below
    // the content against 12px on the other three sides (#2115).
    const onlyResolution = model({ resolution: RESOLUTION });
    render(
      <VideoParamsPicker
        model={onlyResolution}
        params={{}}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-resolution-option-720p').closest('.mb-3'),
    ).toBeNull();
  });

  it('keeps that margin while another group follows it', () => {
    // The complement: a rule that dropped the margin everywhere would pass the
    // case above and collapse every gap in the popover.
    render(
      <VideoParamsPicker
        model={FULL}
        params={{}}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-resolution-option-720p').closest('.mb-3'),
    ).not.toBeNull();
  });

  it('picking a ratio reports the aspect_ratio', () => {
    const onChange = vi.fn();
    render(
      <VideoParamsPicker model={FULL} params={{}} slots={[]} slotUrls={{}} onChange={onChange} />,
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
      <VideoParamsPicker model={FULL} params={{}} slots={[]} slotUrls={{}} onChange={onChange} />,
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
      <VideoParamsPicker model={ranged} params={{}} slots={[]} slotUrls={{}} onChange={onChange} />,
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
        params={{ generate_audio: true }}
        slots={[]}
        slotUrls={{}}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(screen.getByTestId('generate-video-audio-toggle'));
    expect(onChange).toHaveBeenCalledWith({ generate_audio: false });
  });
});

/**
 * The reference video's own audio (#1928).
 *
 * Upstream keeps it by default, so a run with a clip carries that clip's
 * sound into the result unless the user says otherwise — the switch is how
 * they say it. It describes the clip, so it only means anything while one is
 * picked; without a clip there is nothing whose sound to keep.
 */
describe('VideoParamsPicker and the reference clip\'s own sound', () => {
  const KEEP: ParamDescriptor = {
    description: '',
    values: [true, false],
    default: true,
  };
  const WITH_KEEP = model({
    aspect_ratio: RATIO,
    duration: DURATION_LIST,
    // The model says which source the switch hangs on; the panel finds the
    // slot carrying that param.
    keep_original_sound: { ...KEEP, when: { source: 'video' } },
    video: { description: '', default: null, fill: 'canvas', accepts: 'video' },
  });

  it('offers the switch while a reference clip is picked', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={WITH_KEEP}
        params={{ aspect_ratio: '16:9', duration: 6, keep_original_sound: true }}
        slots={['referenceVideo']}
        slotUrls={{ referenceVideo: 'https://cdn/clip.mp4' }}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeInTheDocument();
  });

  it('leaves it out while no clip is picked', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={WITH_KEEP}
        params={{ aspect_ratio: '16:9', duration: 6, keep_original_sound: true }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });

  it('leaves it out while the only clip sits in a slot this mode does not collect', async () => {
    // Two slots carry the `video` param: the driving clip an animation takes
    // and the reference clip this mode takes. A pick is kept when the reader
    // switches modes, so one left behind by the other mode is still on the
    // node while this mode collects nothing -- and the switch describes the
    // audio of a clip that is not part of this run.
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={WITH_KEEP}
        params={{ aspect_ratio: '16:9', duration: 6, keep_original_sound: true }}
        slots={['referenceVideo']}
        slotUrls={{ drivingVideo: 'https://cdn/left-behind.mp4' }}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });

  it('leaves it out for a model that never reads a clip', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={FULL}
        params={{ aspect_ratio: '16:9', duration: 6 }}
        slots={['referenceVideo']}
        slotUrls={{ referenceVideo: 'https://cdn/clip.mp4' }}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });

  it('offers it unconditionally where the model names no source', async () => {
    // The projection reads an absent `when` the same way: a control waiting on
    // nothing is one the reader always has.
    const ungated = model({
      aspect_ratio: RATIO,
      duration: DURATION_LIST,
      keep_original_sound: KEEP,
    });
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={ungated}
        params={{ aspect_ratio: '16:9', duration: 6, keep_original_sound: true }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeInTheDocument();
  });

  it('leaves it out while the filled slot is not the source it waits on', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={WITH_KEEP}
        params={{ aspect_ratio: '16:9', duration: 6, keep_original_sound: true }}
        slots={['firstFrame']}
        slotUrls={{ firstFrame: 'https://cdn/frame.png' }}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });

  it('hangs the switch on whichever source the model names', async () => {
    const onPicture = model({
      aspect_ratio: RATIO,
      duration: DURATION_LIST,
      keep_original_sound: { ...KEEP, when: { source: 'image' } },
      image: { description: '', default: null, fill: 'canvas', accepts: 'image' },
    });
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={onPicture}
        params={{ aspect_ratio: '16:9', duration: 6, keep_original_sound: true }}
        slots={['firstFrame']}
        slotUrls={{ firstFrame: 'https://cdn/frame.png' }}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeInTheDocument();
  });

  it('reports the flip to the caller', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <VideoParamsPicker
        model={WITH_KEEP}
        params={{ aspect_ratio: '16:9', duration: 6, keep_original_sound: true }}
        slots={['referenceVideo']}
        slotUrls={{ referenceVideo: 'https://cdn/clip.mp4' }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    await user.click(
      screen.getByTestId('generate-video-keep-original-sound-toggle'),
    );
    expect(onChange).toHaveBeenCalledWith({ keep_original_sound: false });
  });
});

describe('VideoParamsPicker and a control a switch gates', () => {
  const KEEP: ParamDescriptor = {
    description: '',
    values: [true, false],
    default: true,
  };

  /**
   * Builds a model whose sound switch waits on the audio switch.
   * @param gate - Which way it waits.
   * @returns A model entry declaring that gate.
   */
  function gatedBy(gate: 'flag_on' | 'flag_off'): ModelEntry {
    return model({
      aspect_ratio: RATIO,
      duration: DURATION_LIST,
      generate_audio: AUDIO,
      keep_original_sound: { ...KEEP, when: { [gate]: 'generate_audio' } },
    });
  }

  it('offers a flag_on control while that switch is on', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={gatedBy('flag_on')}
        params={{ aspect_ratio: '16:9', duration: 6, generate_audio: true }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeInTheDocument();
  });

  it('leaves a flag_on control out while that switch is off', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={gatedBy('flag_on')}
        params={{ aspect_ratio: '16:9', duration: 6, generate_audio: false }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });

  it('leaves a flag_off control out while that switch is on', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={gatedBy('flag_off')}
        params={{ aspect_ratio: '16:9', duration: 6, generate_audio: true }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });

  it('reads a switch the record does not carry as the model defaults it', async () => {
    // The container reconciles a node's params against the model before this
    // renders, so every declared param has a key by then. This is the answer
    // for a record that reaches here without one.
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={gatedBy('flag_off')}
        params={{ aspect_ratio: '16:9', duration: 6 }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });
});

describe('VideoParamsPicker and a condition naming a param outside its own controls', () => {
  const KEEP: ParamDescriptor = {
    description: '',
    values: [true, false],
    default: true,
  };
  const POOL_GATED = model({
    aspect_ratio: RATIO,
    duration: DURATION_LIST,
    images: { description: '', default: null, fill: 'pool', accepts: 'image', type: 'list' },
    keep_original_sound: { ...KEEP, when: { source: 'images' } },
  });

  it('offers the control while the named param holds something', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={POOL_GATED}
        params={{
          aspect_ratio: '16:9',
          duration: 6,
          images: ['https://cdn/a.png'],
          keep_original_sound: true,
        }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeInTheDocument();
  });

  it('reads the pool from the value the run will carry', async () => {
    // The container merges the references the prompt names under the pool's
    // own name, which is what the payload builder writes at submit.
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={POOL_GATED}
        params={{
          aspect_ratio: '16:9',
          duration: 6,
          images: ['https://cdn/a.png', 'https://cdn/b.png'],
          keep_original_sound: true,
        }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.getByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeInTheDocument();
  });

  it('leaves it out while the named param holds nothing', async () => {
    const user = userEvent.setup();
    render(
      <VideoParamsPicker
        model={POOL_GATED}
        params={{ aspect_ratio: '16:9', duration: 6, images: [], keep_original_sound: true }}
        slots={[]}
        slotUrls={{}}
        onChange={() => {}}
      />,
    );
    await user.click(screen.getByTestId('generate-video-params-trigger'));
    expect(
      screen.queryByTestId('generate-video-keep-original-sound-toggle'),
    ).toBeNull();
  });
});
