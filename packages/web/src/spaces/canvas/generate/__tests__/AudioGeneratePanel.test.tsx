// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 §6.3 — the audio Generate panel.
 *
 * Same card as the image and video panels: the injected prompt editor over a
 * footer carrying the mode picker, the model picker, the voice picker, the
 * rate and the submit button.
 *
 * Two things here are audio's own. The footer states a RATE rather than a
 * total, because both vendors bill by how much text is sent and the unit they
 * count differs — ElevenLabs per character, Fish per UTF-8 byte, and a Chinese
 * character is three of those. And a node built before generation reached
 * audio has no prompt container at all, so the prompt position has to say so
 * instead of offering an editor that cannot store what is typed into it.
 *
 * `useTranslation` echoes its key, with ICU arguments appended, so assertions
 * name the string and the numbers the panel asks for.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AudioGeneratePanel } from '@web/spaces/canvas/generate/AudioGeneratePanel';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { initialVoiceListState } from '@web/spaces/canvas/generate/voice-list-state';
import type { ModelEntry } from '@breatic/shared';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation:
    () =>
      (key: string, args?: Record<string, unknown>): string =>
        args ? `${key}(${JSON.stringify(args)})` : key,
}));

/**
 * Builds a tts model the way the catalog serves one.
 * @param name - Model id.
 * @param rate - What it charges, if it declares a rate.
 * @returns A model entry.
 */
function ttsModel(name: string, rate?: ModelEntry['rate']): ModelEntry {
  return {
    name,
    display_name: name,
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 0,
    generation_time: 0,
    takes_prompt: true,
    params: {},
    providers: [],
    sourcesByMode: {},
    rate,
  };
}

const ELEVEN = ttsModel('elevenlabs-v3', {
  credits: 10,
  per: 1000,
  unit: 'characters',
});
const FISH = ttsModel('fish-s2-pro', {
  credits: 1.5,
  per: 1000,
  unit: 'utf8_bytes',
});

/** The props every case supplies, so a case names only what it exercises. */
const BASE = {
  models: [ELEVEN, FISH],
  model: 'elevenlabs-v3',
  mode: 'tts',
  modeOptions: AUDIO_MODE_OPTIONS,
  voiceList: initialVoiceListState,
  voiceSelectedId: null,
  voiceSelectedName: null,
  executeRefusal: null,
  promptSlot: <div data-testid='prompt-editor' />,
  onToggleMode: (): void => {},
  onSelectModel: (): void => {},
  onVoiceOpenChange: (): void => {},
  onVoiceQueryChange: (): void => {},
  onVoicePick: (): void => {},
  onVoiceLoadMore: (): void => {},
  onExit: (): void => {},
  onExecute: (): void => {},
};

describe('AudioGeneratePanel (#1960 A1)', () => {
  it('shows the prompt editor the container injected', () => {
    render(<AudioGeneratePanel {...BASE} />);
    expect(screen.getByTestId('prompt-editor')).toBeInTheDocument();
  });

  it('offers the mode picker, the model picker and the voice picker', () => {
    render(<AudioGeneratePanel {...BASE} />);
    expect(screen.getByTestId('generate-audio-mode-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-model-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-voice-trigger')).toBeInTheDocument();
  });

  it('closes without generating', () => {
    const onExit = vi.fn();
    render(<AudioGeneratePanel {...BASE} onExit={onExit} />);
    fireEvent.click(screen.getByTestId('generate-audio-exit'));
    expect(onExit).toHaveBeenCalled();
  });

  it('submits when the button is pressed', () => {
    const onExecute = vi.fn();
    render(<AudioGeneratePanel {...BASE} onExecute={onExecute} />);
    fireEvent.click(screen.getByTestId('generate-audio-execute'));
    expect(onExecute).toHaveBeenCalled();
  });

  it('hands the picked model up', () => {
    const onSelectModel = vi.fn();
    render(<AudioGeneratePanel {...BASE} onSelectModel={onSelectModel} />);
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    fireEvent.click(screen.getByTestId('generate-model-option-fish-s2-pro'));
    expect(onSelectModel).toHaveBeenCalledWith('fish-s2-pro');
  });
});

describe('AudioGeneratePanel rate (#1960 A5)', () => {
  it('states what the model charges per unit of text, not a total', () => {
    render(<AudioGeneratePanel {...BASE} />);
    expect(screen.getByTestId('generate-audio-rate')).toHaveTextContent(
      'canvas.generatePanel.rateCharacters',
    );
    expect(screen.getByTestId('generate-audio-rate')).toHaveTextContent(
      '"credits":10',
    );
  });

  it('counts bytes for the vendor that bills that way', () => {
    // Fish charges per UTF-8 byte and a Chinese character is three of them, so
    // one shared "per 1000 characters" wording would understate it threefold.
    render(<AudioGeneratePanel {...BASE} model='fish-s2-pro' />);
    expect(screen.getByTestId('generate-audio-rate')).toHaveTextContent(
      'canvas.generatePanel.rateBytes',
    );
  });

  it('says nothing where the model declares no rate', () => {
    render(
      <AudioGeneratePanel
        {...BASE}
        models={[ttsModel('no-rate')]}
        model='no-rate'
      />,
    );
    expect(screen.queryByTestId('generate-audio-rate')).toBeNull();
  });
});

describe('AudioGeneratePanel execute button (#1960 A12)', () => {
  it('stays pressable when a voice is still to be picked', () => {
    // The refusal is one the user can act on, so the button says what is
    // missing rather than going grey with nothing to explain it.
    render(<AudioGeneratePanel {...BASE} executeRefusal='voice-missing' />);
    expect(screen.getByTestId('generate-audio-execute')).not.toBeDisabled();
  });

  it('greys out for a refusal the user cannot act on', () => {
    // `no-model` is an environment fact: no amount of typing changes it, so
    // there is nothing for a pressable button to say.
    render(<AudioGeneratePanel {...BASE} executeRefusal='no-model' />);
    expect(screen.getByTestId('generate-audio-execute')).toBeDisabled();
  });

  it('spins while a submit is in flight', () => {
    render(<AudioGeneratePanel {...BASE} executeRefusal='submitting' />);
    expect(
      screen.getByTestId('generate-audio-execute-pending'),
    ).toBeInTheDocument();
  });
});

describe('AudioGeneratePanel on a node built before generation (#1960 A13)', () => {
  it('says so in the prompt position instead of showing an editor', () => {
    // Audio was never in GENERATIVE_MODALITIES, so no audio node on the canvas
    // today has a prompt container. An editor rendered here would take typing
    // and store none of it.
    render(<AudioGeneratePanel {...BASE} promptSlot={null} />);
    expect(screen.getByTestId('generate-audio-legacy')).toHaveTextContent(
      'canvas.generatePanel.audioLegacyNoPrompt',
    );
    expect(screen.queryByTestId('prompt-editor')).toBeNull();
  });

  it('keeps the footer usable, so the panel is not a dead end', () => {
    render(<AudioGeneratePanel {...BASE} promptSlot={null} />);
    expect(screen.getByTestId('generate-model-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-audio-exit')).toBeInTheDocument();
  });
});
