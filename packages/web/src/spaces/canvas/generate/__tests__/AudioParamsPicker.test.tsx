// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import type * as React from 'react';

// Pass the tooltip primitives through: real Radix Tooltip throws without the
// app-level provider, and this trigger is both a TooltipTrigger and a
// PopoverTrigger.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { AudioParamsPicker } from '@web/spaces/canvas/generate/AudioParamsPicker';

/**
 * A tts model declaring the given params.
 * @param params - The model's param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 10,
    generation_time: 30,
    takes_prompt: true,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

const ELEVENLABS = model({
  voice_id: { description: '', default: 'Alice', remote_source: 'voices' },
  stability: { description: '', min: 0, max: 1, step: 0.05, default: 0.5 },
  similarity: { description: '', min: 0, max: 1, step: 0.05, default: 0.75 },
});
const FISH = model({
  speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  volume: { description: '', min: -20, max: 20, step: 1, default: 0 },
});
// No tts model in the catalogue states a param as a list of stops today, and
// the panel still reads one as a row of options. Written here rather than left
// to a real model, because a declaration the panel cannot show renders nothing
// at all while its value still travels to the vendor.
const STOPPED = model({
  speed: { description: '', values: [0.5, 1, 2], default: 1 },
});

/**
 * Renders the picker and opens its popover.
 * @param entry - The active model.
 * @param value - The current values.
 * @param onChange - Change handler.
 */
function open(
  entry: ModelEntry,
  value: Record<string, number>,
  onChange: (partial: Record<string, number>) => void = () => {},
): void {
  render(<AudioParamsPicker model={entry} value={value} onChange={onChange} />);
  fireEvent.click(screen.getByTestId('generate-audio-params-trigger'));
}

describe('AudioParamsPicker — the speaking params the active model declares', () => {
  it('offers stability as a slider carrying the model\'s own bounds', () => {
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 });
    const slider = screen.getByRole('slider', { name: 'Stability' });
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '1');
    expect(slider).toHaveAttribute('aria-valuenow', '0.5');
  });

  it('names the three positions the vendor described, under the slider', () => {
    // Nothing about 0.50 says what it will sound like, and the vendor
    // describes exactly three points on that scale (user 2026-09-03).
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 });
    for (const [at, name] of [
      ['0', 'Creative'],
      ['0.5', 'Natural'],
      ['1', 'Robust'],
    ]) {
      expect(
        screen.getByTestId(`generate-audio-stability-stop-${at}`),
      ).toHaveTextContent(name);
    }
  });

  it('marks the stop the value is sitting on', () => {
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 });
    expect(screen.getByTestId('generate-audio-stability-stop-0.5')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('generate-audio-stability-stop-0')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('marks none of them between two stops', () => {
    // The value is continuous and 0.35 is not a position anyone described;
    // lighting the nearest would name it something the vendor did not.
    open(ELEVENLABS, { stability: 0.35, similarity: 0.75 });
    for (const at of ['0', '0.5', '1']) {
      expect(screen.getByTestId(`generate-audio-stability-stop-${at}`)).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  it('jumps to a stop when it is pressed', () => {
    const onChange = vi.fn();
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 }, onChange);
    fireEvent.click(screen.getByTestId('generate-audio-stability-stop-1'));
    expect(onChange).toHaveBeenCalledWith({ stability: 1 });
  });

  it('leaves similarity without stops — nobody named a position on it', () => {
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 });
    expect(
      screen.queryByTestId('generate-audio-similarity-stop-0'),
    ).not.toBeInTheDocument();
  });

  it('offers similarity as a slider carrying the model\'s own bounds', () => {
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 });
    const slider = screen.getByRole('slider', { name: 'Similarity' });
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '1');
    expect(slider).toHaveAttribute('aria-valuenow', '0.75');
  });

  it('shows Fish\'s pair and neither of ElevenLabs\'', () => {
    open(FISH, { speed: 1, volume: 0 });
    expect(screen.getByRole('slider', { name: 'Speed' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Similarity' })).toBeNull();
    expect(screen.queryByTestId('generate-audio-stability-option-0')).toBeNull();
  });

  it('reads each value in its own unit beside its label', () => {
    open(FISH, { speed: 1.25, volume: -5 });
    expect(screen.getByTestId('generate-audio-speed-value')).toHaveTextContent('1.25x');
    expect(screen.getByTestId('generate-audio-volume-value')).toHaveTextContent('-5 dB');
  });

  it('reads a param stated as stops as a row of options', () => {
    open(STOPPED, { speed: 1 });
    expect(screen.getByTestId('generate-audio-speed-option-0.5')).toBeInTheDocument();
    expect(screen.getByTestId('generate-audio-speed-option-1')).toBeInTheDocument();
    expect(screen.getByTestId('generate-audio-speed-option-2')).toBeInTheDocument();
  });

  it('picking a stop fires onChange with the NUMBER', () => {
    // The catalog states these as numbers and the vendor expects numbers; a
    // display string would reach the provider as "2.00x" and be rejected.
    const onChange = vi.fn();
    open(STOPPED, { speed: 1 }, onChange);
    fireEvent.click(screen.getByTestId('generate-audio-speed-option-2'));
    expect(onChange).toHaveBeenCalledWith({ speed: 2 });
  });

  it('moving a slider fires onChange with the stepped value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    open(FISH, { speed: 1, volume: 0 }, onChange);
    screen.getByRole('slider', { name: 'Speed' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith({ speed: 1.05 });
  });

  it('falls back to the model default when the node holds no value yet', () => {
    // A node generated before this control existed has nothing stored; the
    // control must show what the model would use, not an empty slider.
    open(ELEVENLABS, {});
    expect(screen.getByRole('slider', { name: 'Similarity' })).toHaveAttribute(
      'aria-valuenow',
      '0.75',
    );
  });

  it('renders nothing at all for a model declaring no such param', () => {
    // No empty pill that opens onto nothing.
    render(
      <AudioParamsPicker
        model={model({ voice_id: { description: '', default: null, remote_source: 'voices' } })}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId('generate-audio-params-trigger')).toBeNull();
  });
});

describe('AudioParamsPicker — when a slider writes', () => {
  /**
   * Give a slider a real box and stub pointer capture, neither of which jsdom
   * provides, so Radix can turn a pointer position into a value.
   * @param root - The slider's Radix root.
   */
  function makeDraggable(root: HTMLElement): void {
    root.setPointerCapture = vi.fn();
    root.releasePointerCapture = vi.fn();
    root.hasPointerCapture = vi.fn(() => true);
    root.getBoundingClientRect = (): DOMRect =>
      ({ left: 0, right: 100, width: 100, top: 0, bottom: 10, height: 10 }) as DOMRect;
  }

  it('writes nothing while a drag is in flight, and shows where the thumb went', () => {
    // Every step a drag crosses is one Yjs write, and the canvas undo stack
    // holds 50 entries with no time-based merging — so one drag of a 41-stop
    // param would push out most of what the user could still undo.
    const onChange = vi.fn();
    open(FISH, { speed: 1, volume: 0 }, onChange);
    const root = screen.getByTestId('generate-audio-speed-slider');
    makeDraggable(root);

    fireEvent.pointerDown(root, { pointerId: 1, clientX: 50, button: 0, ctrlKey: false });
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 80 });

    expect(onChange).not.toHaveBeenCalled();
    // The thumb still has to follow the finger, or the control reads as broken.
    expect(screen.getByTestId('generate-audio-speed-value')).toHaveTextContent('1.70x');
  });

  it('writes once, when the drag ends', () => {
    const onChange = vi.fn();
    open(FISH, { speed: 1, volume: 0 }, onChange);
    const root = screen.getByTestId('generate-audio-speed-slider');
    makeDraggable(root);

    fireEvent.pointerDown(root, { pointerId: 1, clientX: 50, button: 0, ctrlKey: false });
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 80 });
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 80 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ speed: 1.7 });
  });

  it('holding an arrow key writes where it started and where it ended', () => {
    // The browser repeats a held key about thirty times a second and Radix
    // commits on every one of them. Volume has 41 stops, so holding from one
    // end to the other would fill most of a 50-deep undo stack with steps of
    // one gesture. The press is the decision; the repeats are it continuing.
    const onChange = vi.fn();
    open(FISH, { speed: 1, volume: 0 }, onChange);
    const thumb = screen.getByRole('slider', { name: 'Speed' });

    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(thumb, { key: 'ArrowRight', repeat: true });
    }
    fireEvent.keyUp(thumb, { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, { speed: 1.05 });
    expect(onChange).toHaveBeenNthCalledWith(2, { speed: 1.2 });
  });

  it('writes the held value when the release lands somewhere else', () => {
    // A key released after the window was switched away never reaches this
    // page. The gesture still ended, and what the user dialled in has to
    // reach the node.
    const onChange = vi.fn();
    open(FISH, { speed: 1, volume: 0 }, onChange);
    const thumb = screen.getByRole('slider', { name: 'Speed' });
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.keyDown(thumb, { key: 'ArrowRight', repeat: true });
    fireEvent.keyDown(thumb, { key: 'ArrowRight', repeat: true });
    fireEvent.blur(screen.getByTestId('generate-audio-speed-slider'));

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ speed: 1.15 });
  });

  it('answers the pointer again after a key release it never saw', () => {
    // Whether a key is still down is remembered in a ref, and every commit
    // reads it — the pointer's included. Left set by a release that landed
    // elsewhere, it swallows drags the user makes afterwards, and they see
    // the thumb move while the node keeps the old value.
    const onChange = vi.fn();
    open(FISH, { speed: 1, volume: 0 }, onChange);
    const thumb = screen.getByRole('slider', { name: 'Speed' });
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.keyDown(thumb, { key: 'ArrowRight', repeat: true });
    onChange.mockClear();

    const root = screen.getByTestId('generate-audio-speed-slider');
    root.setPointerCapture = vi.fn();
    root.releasePointerCapture = vi.fn();
    root.hasPointerCapture = vi.fn(() => true);
    root.getBoundingClientRect = (): DOMRect =>
      ({ left: 0, right: 100, width: 100, top: 0, bottom: 10, height: 10 }) as DOMRect;
    fireEvent.pointerDown(root, { pointerId: 1, clientX: 50, button: 0, ctrlKey: false });
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 80 });
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 80 });

    expect(onChange).toHaveBeenCalledWith({ speed: 1.7 });
  });

  it('lets go of the drafted value once the key is up', () => {
    // Radix reports a keyboard commit before it reports the change, so the
    // draft cleared inside the commit is written straight back. Left set, the
    // row shows this client's number over anything a collaborator stores.
    const onChange = vi.fn();
    const { rerender } = render(
      <AudioParamsPicker model={FISH} value={{ speed: 1, volume: 0 }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('generate-audio-params-trigger'));
    const thumb = screen.getByRole('slider', { name: 'Speed' });
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.keyUp(thumb, { key: 'ArrowRight' });

    rerender(
      <AudioParamsPicker model={FISH} value={{ speed: 0.8, volume: 0 }} onChange={onChange} />,
    );
    expect(screen.getByTestId('generate-audio-speed-value')).toHaveTextContent('0.80x');
  });
});

describe('AudioParamsPicker trigger carries the values, like the video panel', () => {
  it('prints what the params are set to, each in its own unit', () => {
    // VideoParamsPicker joins the declared values with a middot and prints
    // them on the trigger; the row reads as four pills each naming what it
    // holds.
    render(
      <AudioParamsPicker
        model={ELEVENLABS}
        value={{ stability: 0.5, similarity: 0.75 }}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByTestId('generate-audio-params-trigger');
    expect(trigger).toHaveTextContent('0.50 · 0.75');
  });

  it('prints Fish\'s pair in their own units', () => {
    render(
      <AudioParamsPicker
        model={FISH}
        value={{ speed: 1.25, volume: -5 }}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByTestId('generate-audio-params-trigger');
    expect(trigger).toHaveTextContent('1.25x');
    expect(trigger).toHaveTextContent('-5 dB');
  });

  it('is filled like the pills beside it, not left as bare chrome', () => {
    // The three pills to its left carry bg-background. An unfilled control in
    // that row reads as a switch that is off, and these params are never off.
    render(
      <AudioParamsPicker
        model={FISH}
        value={{ speed: 1, volume: 0 }}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByTestId('generate-audio-params-trigger').className,
    ).toContain('bg-background');
  });
});
