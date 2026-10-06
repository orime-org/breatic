// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

import { AudioSettingsPicker } from '@web/spaces/canvas/generate/AudioSettingsPicker';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import { initialVoiceListState } from '@web/spaces/canvas/generate/voice-list-state';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A voice source nobody reads; these cases are about the params. */
const NO_VOICE = {
  list: initialVoiceListState,
  selectedId: null,
  selectedName: null,
  onOpenChange: (): void => {},
  onQueryChange: (): void => {},
  onPick: (): void => {},
  onLoadMore: (): void => {},
};

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
    generation_time: 30,
    takes_prompt: true,
    params,
    providers: [],
  };
}

const ELEVENLABS = model({
  voice_id: { description: '', default: 'Alice', remote_source: 'voices' },
  stability: { description: '', min: 0, max: 1, step: 0.05, default: 0.5 },
  similarity: { description: '', min: 0, max: 1, step: 0.05, default: 0.75 },
});
// As minimax-speech-2.8-hd declares them: volume is a gain, 1 unchanged.
const MINIMAX = model({
  speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  volume: { description: '', min: 0.1, max: 10, step: 0.1, default: 1 },
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
  onChange: (partial: object) => void = () => {},
): void {
  render(
    <AudioSettingsPicker mode='tts' model={entry} value={resolveParamsForModel(entry, value)} onChange={onChange} voice={NO_VOICE} />,
  );
  fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
}

describe('AudioSettingsPicker — the speaking params the active model declares', () => {
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

  it('shows MiniMax\'s pair and neither of ElevenLabs\'', () => {
    open(MINIMAX, { speed: 1, volume: 1 });
    expect(screen.getByRole('slider', { name: 'Speed' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Similarity' })).toBeNull();
    expect(screen.queryByTestId('generate-audio-stability-option-0')).toBeNull();
  });

  it('reads each value in its own unit beside its label', () => {
    open(MINIMAX, { speed: 1.25, volume: 0.5 });
    expect(screen.getByTestId('generate-audio-speed-value')).toHaveTextContent('1.25x');
    expect(screen.getByTestId('generate-audio-volume-value')).toHaveTextContent('0.50x');
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
    open(MINIMAX, { speed: 1, volume: 1 }, onChange);
    screen.getByRole('slider', { name: 'Speed' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith({ speed: 1.05 });
  });

  it('shows the model default a node that holds nothing resolves to', () => {
    open(ELEVENLABS, {});
    expect(screen.getByRole('slider', { name: 'Similarity' })).toHaveAttribute(
      'aria-valuenow',
      '0.75',
    );
  });

  it('renders nothing at all for a model with no voice and no param', () => {
    // No empty pill that opens onto nothing.
    render(<AudioSettingsPicker mode='tts' voice={NO_VOICE} model={model({})} value={{}} onChange={() => {}} />);
    expect(screen.queryByTestId('generate-audio-settings-trigger')).toBeNull();
  });

  it('holds the voice for a model whose only setting is its voice', () => {
    // The voice is one of the settings now (design §16.1), so a voice-only
    // model still gets the pill, opening onto the voice row.
    render(
      <AudioSettingsPicker mode='tts'
        voice={NO_VOICE}
        model={model({ voice_id: { description: '', default: null, remote_source: 'voices' } })}
        value={{}}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    expect(screen.getByTestId('generate-audio-row-voice_id')).toBeInTheDocument();
  });
});

describe('AudioSettingsPicker — when a slider writes', () => {
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
    open(MINIMAX, { speed: 1, volume: 1 }, onChange);
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
    open(MINIMAX, { speed: 1, volume: 1 }, onChange);
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
    open(MINIMAX, { speed: 1, volume: 1 }, onChange);
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
    open(MINIMAX, { speed: 1, volume: 1 }, onChange);
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
    open(MINIMAX, { speed: 1, volume: 1 }, onChange);
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
      <AudioSettingsPicker mode='tts' voice={NO_VOICE} model={MINIMAX} value={{ speed: 1, volume: 1 }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    const thumb = screen.getByRole('slider', { name: 'Speed' });
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.keyUp(thumb, { key: 'ArrowRight' });

    rerender(
      <AudioSettingsPicker mode='tts' voice={NO_VOICE} model={MINIMAX} value={{ speed: 0.8, volume: 1 }} onChange={onChange} />,
    );
    expect(screen.getByTestId('generate-audio-speed-value')).toHaveTextContent('0.80x');
  });
});

describe('AudioSettingsPicker trigger carries the values, like the video panel', () => {
  it('prints what the params are set to, each in its own unit', () => {
    // VideoParamsPicker joins the declared values with a middot and prints
    // them on the trigger; the row reads as four pills each naming what it
    // holds.
    render(
      <AudioSettingsPicker mode='tts'
        voice={NO_VOICE}
        model={ELEVENLABS}
        value={{ stability: 0.5, similarity: 0.75 }}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByTestId('generate-audio-settings-trigger');
    expect(trigger).toHaveTextContent('0.50 · 0.75');
  });

  it('prints MiniMax\'s pair in their own units', () => {
    render(
      <AudioSettingsPicker mode='tts'
        voice={NO_VOICE}
        model={MINIMAX}
        value={{ speed: 1.25, volume: 0.5 }}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByTestId('generate-audio-settings-trigger');
    expect(trigger).toHaveTextContent('1.25x');
    expect(trigger).toHaveTextContent('0.50x');
  });

  it('is filled like the pills beside it, not left as bare chrome', () => {
    // The three pills to its left carry bg-background. An unfilled control in
    // that row reads as a switch that is off, and these params are never off.
    render(
      <AudioSettingsPicker mode='tts'
        voice={NO_VOICE}
        model={MINIMAX}
        value={{ speed: 1, volume: 1 }}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByTestId('generate-audio-settings-trigger').className,
    ).toContain('bg-background');
  });
});

describe('AudioSettingsPicker — a model that reads a dialogue (#2156, design §16)', () => {
  const TAGS = ['en-US', 'ja-JP', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'ko-KR', 'nl-NL', 'pl-PL'];
  const GEMINI = model({
    language: {
      description: '',
      label: 'Language',
      fill: 'panel',
      default: 'English (United States)',
      values: TAGS.map((tag) => `lang ${tag}`).map((v, i) => (i === 0 ? 'English (United States)' : v)),
      value_locales: TAGS,
    },
    speakers: {
      description: '',
      label: 'Speakers',
      fill: 'panel',
      default: null,
      type: 'items',
      min_items: 2,
      max_items: 2,
      replaces: 'voice_id',
      fields: { speaker: { type: 'text' }, voice: { values: ['Kore', 'Puck'] } },
    },
    voice_id: { description: '', default: 'Kore', remote_source: 'voices', fill: 'remote' },
  });
  const nameOf = (tag: string): string =>
    new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(tag) ?? tag;

  it('reads top to bottom as reading mode, language, voice', () => {
    render(<AudioSettingsPicker mode='tts' voice={NO_VOICE} model={GEMINI} value={resolveParamsForModel(GEMINI, {})} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    const order = [
      screen.getByTestId('generate-audio-reading-single'),
      screen.getByTestId('generate-audio-row-language'),
      screen.getByTestId('generate-audio-row-voice_id'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.queryByTestId('generate-audio-row-speakers')).toBeNull();
  });

  it('insets rows and groups 12px like the image and video popovers, labels in one style', () => {
    // Popover p-2 (8px) + 4px on each block = the p-3 the other two use.
    render(<AudioSettingsPicker mode='tts' voice={NO_VOICE} model={GEMINI} value={resolveParamsForModel(GEMINI, {})} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    const row = screen.getByTestId('generate-audio-row-language');
    expect(row.className).toContain('px-1');
    expect(row.firstElementChild).toHaveClass('text-xs', 'font-medium');
    expect(screen.getByTestId('generate-audio-reading-single').closest('.px-1')).not.toBeNull();
  });

  it('points the open row\'s arrow at the side the second panel opens on', () => {
    // A first panel near the window's right edge sends the second one left.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 700, right: 1000, top: 0, bottom: 0, width: 300, height: 0, x: 700, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    render(<AudioSettingsPicker mode='tts' voice={NO_VOICE} model={GEMINI} value={resolveParamsForModel(GEMINI, {})} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-row-language'));
    expect(screen.getByTestId('generate-audio-second-panel')).toHaveAttribute('data-side', 'left');
    expect(screen.getByTestId('generate-audio-row-language').querySelector('.lucide-chevron-left')).not.toBeNull();
    rect.mockRestore();
  });

  it('writes the dialogue switch, and shows the speakers in place of the voice', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AudioSettingsPicker mode='tts' voice={NO_VOICE} model={GEMINI} value={resolveParamsForModel(GEMINI, {})} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-reading-dialogue'));
    expect(onChange).toHaveBeenCalledWith({ _stand_in_on: true });
    rerender(
      <AudioSettingsPicker mode='tts' voice={NO_VOICE} model={GEMINI} value={{ _stand_in_on: true }} onChange={onChange} />,
    );
    expect(screen.getByTestId('generate-audio-row-speakers-0')).toBeInTheDocument();
    expect(screen.getByTestId('generate-audio-row-speakers-1')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-audio-row-voice_id')).toBeNull();
  });

  it('names each language in the reader\'s language and picks one from a searchable list beside', () => {
    const onChange = vi.fn();
    render(<AudioSettingsPicker mode='tts' voice={NO_VOICE} model={GEMINI} value={resolveParamsForModel(GEMINI, {})} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    expect(screen.getByTestId('generate-audio-row-language')).toHaveTextContent(nameOf('en-US'));
    fireEvent.click(screen.getByTestId('generate-audio-row-language'));
    expect(screen.getByTestId('generate-audio-second-panel')).toHaveTextContent(nameOf('ja-JP'));
    fireEvent.change(screen.getByTestId('generate-audio-option-language-search'), {
      target: { value: nameOf('ja-JP').slice(0, 4) },
    });
    expect(screen.queryByText(nameOf('fr-FR'))).toBeNull();
    fireEvent.click(screen.getByText(nameOf('ja-JP')));
    expect(onChange).toHaveBeenCalledWith({ language: 'lang ja-JP' });
    expect(screen.queryByTestId('generate-audio-second-panel')).toBeNull();
    // The first panel stays: the reader may have more to set.
    expect(screen.getByTestId('generate-audio-row-language')).toBeInTheDocument();
  });

  it('draws the open row\'s name in full foreground, since the row sits on the accent fill', () => {
    // Muted text on the accent fill measures 4.46:1 in the dark theme, under
    // the 4.5:1 floor for 13px text; the rows that are not open keep it muted.
    render(<AudioSettingsPicker mode='tts' voice={NO_VOICE} model={GEMINI} value={resolveParamsForModel(GEMINI, {})} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-row-language'));
    const nameIn = (row: string): HTMLElement => screen.getByTestId(`generate-audio-row-${row}`).firstElementChild as HTMLElement;
    expect(nameIn('language')).toHaveClass('text-foreground');
    expect(nameIn('language')).not.toHaveClass('text-muted-foreground');
    expect(nameIn('voice_id')).toHaveClass('text-muted-foreground');
  });

  const SPEAKER_VOICES = {
    ...NO_VOICE,
    list: { ...initialVoiceListState, status: 'ready' as const, voices: [{ id: 'Kore', name: 'Kore' }, { id: 'Puck', name: 'Puck' }] },
  };
  const DIALOGUE = { _stand_in_on: true, speakers: [{ speaker: 'Ana', voice: 'Kore' }, { speaker: '', voice: 'Puck' }] };

  it('gives each speaker a row reading the name and the voice, with the script hint under them (#2256)', () => {
    render(<AudioSettingsPicker mode='tts' voice={SPEAKER_VOICES} model={GEMINI} value={DIALOGUE} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    expect(screen.getByTestId('generate-audio-row-speakers-0')).toHaveTextContent('Speaker 1');
    expect(screen.getByTestId('generate-audio-row-speakers-0')).toHaveTextContent('Ana · Kore');
    expect(screen.getByTestId('generate-audio-row-speakers-1')).toHaveTextContent('Speaker 2');
    expect(screen.getByTestId('generate-audio-row-speakers-1').textContent).not.toContain('·');
    expect(screen.queryByTestId('generate-audio-row-speakers-2')).toBeNull();
    expect(screen.getByText('Write each line as "Name: line"')).toBeInTheDocument();
    expect(screen.getByTestId('generate-audio-settings-trigger')).toHaveTextContent('Dialogue · 2');
  });

  it('opens a speaker with a name box over the same voice list, the speaker\'s voice chosen (#2256)', () => {
    render(<AudioSettingsPicker mode='tts' voice={SPEAKER_VOICES} model={GEMINI} value={DIALOGUE} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-row-speakers-1'));
    const panel = screen.getByTestId('generate-audio-second-panel');
    expect(screen.getByTestId('generate-audio-speaker-name')).toHaveValue('');
    expect(panel).toContainElement(screen.getByTestId('generate-voice-search'));
    expect(screen.getByTestId('generate-voice-option-Puck')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('generate-voice-option-Kore')).toHaveAttribute('aria-pressed', 'false');
  });

  it('writes the name on Enter and on leaving the box, but not on the Enter that confirms an IME word (#2256)', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onChange = vi.fn();
    render(<AudioSettingsPicker mode='tts' voice={SPEAKER_VOICES} model={GEMINI} value={DIALOGUE} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-row-speakers-1'));
    const box = screen.getByTestId('generate-audio-speaker-name');
    fireEvent.change(box, { target: { value: 'Ben' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ speakers: [{ speaker: 'Ana', voice: 'Kore' }, { speaker: 'Ben', voice: 'Puck' }] });
    onChange.mockClear();
    fireEvent.change(box, { target: { value: 'Cy' } });
    fireEvent.blur(box);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ speakers: [{ speaker: 'Ana', voice: 'Kore' }, { speaker: 'Cy', voice: 'Puck' }] }),
    );
  });

  it('picks a speaker\'s voice from the list and folds the panel (#2256)', () => {
    const onChange = vi.fn();
    render(<AudioSettingsPicker mode='tts' voice={SPEAKER_VOICES} model={GEMINI} value={DIALOGUE} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-row-speakers-0'));
    fireEvent.click(screen.getByTestId('generate-voice-option-Puck'));
    expect(onChange).toHaveBeenCalledWith({ speakers: [{ speaker: 'Ana', voice: 'Puck' }, { speaker: '', voice: 'Puck' }] });
    expect(screen.queryByTestId('generate-audio-second-panel')).toBeNull();
  });

  it('fills an unset dialogue to two speakers with no name and the first voice (#2256)', () => {
    const onChange = vi.fn();
    render(<AudioSettingsPicker mode='tts' voice={SPEAKER_VOICES} model={GEMINI} value={{ _stand_in_on: true }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    expect(screen.getByTestId('generate-audio-row-speakers-0')).toHaveTextContent('Kore');
    fireEvent.click(screen.getByTestId('generate-audio-row-speakers-1'));
    fireEvent.click(screen.getByTestId('generate-voice-option-Puck'));
    expect(onChange).toHaveBeenCalledWith({ speakers: [{ speaker: '', voice: 'Kore' }, { speaker: '', voice: 'Puck' }] });
  });

  it('clears the voice search when moving from one speaker to the other (#2256)', () => {
    const onQueryChange = vi.fn();
    render(
      <AudioSettingsPicker mode='tts' voice={{ ...SPEAKER_VOICES, onQueryChange }} model={GEMINI} value={DIALOGUE} onChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-audio-settings-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-row-speakers-0'));
    onQueryChange.mockClear();
    fireEvent.click(screen.getByTestId('generate-audio-row-speakers-1'));
    expect(onQueryChange).toHaveBeenCalledWith('');
    expect(screen.getByTestId('generate-audio-speaker-name')).toHaveValue('');
  });

  it('prints a short choice the panel draws in place, the declared default where the node holds none', () => {
    const emotional = model({
      voice_id: { description: '', default: null, remote_source: 'voices', fill: 'remote' },
      emotion: { description: '', label: 'Emotion', fill: 'panel', default: 'happy', values: ['happy', 'sad'] },
    });
    render(
      <AudioSettingsPicker mode='tts'
        voice={{ ...NO_VOICE, selectedId: 'v', selectedName: 'Vera' }}
        model={emotional}
        value={resolveParamsForModel(emotional, {})}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('generate-audio-settings-trigger')).toHaveTextContent('Vera · Happy');
  });

  it('reads the whole popover on the pill in its order, naming a list while it holds entries', () => {
    const minimax = model({
      emotion: { description: '', label: 'Emotion', fill: 'panel', default: 'happy', values: ['happy', 'sad'] },
      pronunciation_dict: {
        description: '', label: 'Pronunciations', fill: 'panel', default: null, type: 'items',
        fields: { text: { type: 'text' }, pronunciation: { type: 'text' } },
      },
      speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
      voice_id: { description: '', default: null, remote_source: 'voices', fill: 'remote' },
    });
    const props = { voice: { ...NO_VOICE, selectedId: 'v', selectedName: 'Vera' }, model: minimax, onChange: () => {} };
    const { rerender } = render(
      <AudioSettingsPicker mode='tts' {...props} value={{ ...resolveParamsForModel(minimax, {}), pronunciation_dict: [{ text: 'a', pronunciation: 'b' }] }} />,
    );
    const trigger = screen.getByTestId('generate-audio-settings-trigger');
    expect(trigger).toHaveTextContent('Pronunciations · Vera · 1.00x · Happy');
    rerender(<AudioSettingsPicker mode='tts' {...props} value={resolveParamsForModel(minimax, {})} />);
    expect(trigger).toHaveTextContent(/^Vera · 1\.00x · Happy$/);
  });

  it('caps the pill at 150px and prints the language, then the voice, as the popover lists them', () => {
    render(
      <AudioSettingsPicker mode='tts'
        voice={{ ...NO_VOICE, selectedId: 'Kore', selectedName: 'Kore' }}
        model={GEMINI}
        value={resolveParamsForModel(GEMINI, {})}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByTestId('generate-audio-settings-trigger');
    expect(trigger.className).toContain('max-w-[150px]');
    expect(trigger).toHaveTextContent(`${nameOf('en-US')} · Kore`);
  });
});
