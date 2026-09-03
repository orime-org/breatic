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
import type * as React from 'react';

import { TooltipProvider } from '@web/components/ui/tooltip';
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

/**
 * Renders inside the app-level TooltipProvider (App.tsx mounts the real one) —
 * the toolbar's tools are tooltip-wrapped and bare Radix Tooltips throw.
 * @param ui - The panel element.
 * @returns The render result.
 */
function renderPanel(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/** The props every case supplies, so a case names only what it exercises. */
const BASE = {
  models: [ELEVEN, FISH],
  model: 'elevenlabs-v3',
  currentModel: ELEVEN,
  modelTakesPrompt: true,
  mode: 'tts',
  modeOptions: AUDIO_MODE_OPTIONS,
  voiceList: initialVoiceListState,
  voiceSelectedId: null,
  voiceSelectedName: null,
  creditEstimate: 10,
  executeRefusal: null,
  promptSlot: <div data-testid='prompt-editor' />,
  references: [],
  params: {},
  referencePicking: false,
  onAddReference: (): void => {},
  onRemoveReference: (): void => {},
  onInsertReference: (): void => {},
  onChangeParams: (): void => {},
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
    renderPanel(<AudioGeneratePanel {...BASE} />);
    expect(screen.getByTestId('prompt-editor')).toBeInTheDocument();
  });

  it('offers the mode picker, the model picker and the voice picker', () => {
    renderPanel(<AudioGeneratePanel {...BASE} />);
    expect(screen.getByTestId('generate-audio-mode-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-model-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-voice-trigger')).toBeInTheDocument();
  });

  it('closes without generating', () => {
    const onExit = vi.fn();
    renderPanel(<AudioGeneratePanel {...BASE} onExit={onExit} />);
    fireEvent.click(screen.getByTestId('generate-audio-exit'));
    expect(onExit).toHaveBeenCalled();
  });

  it('submits when the button is pressed', () => {
    const onExecute = vi.fn();
    renderPanel(<AudioGeneratePanel {...BASE} onExecute={onExecute} />);
    fireEvent.click(screen.getByTestId('generate-audio-execute'));
    expect(onExecute).toHaveBeenCalled();
  });

  it('hands the picked model up', () => {
    const onSelectModel = vi.fn();
    renderPanel(<AudioGeneratePanel {...BASE} onSelectModel={onSelectModel} />);
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    fireEvent.click(screen.getByTestId('generate-model-option-fish-s2-pro'));
    expect(onSelectModel).toHaveBeenCalledWith('fish-s2-pro');
  });
});

describe('AudioGeneratePanel credit estimate (#1960 A5)', () => {
  it('prints the number and nothing around it, as the video panel does', () => {
    // A bare figure beside the star: same shape as VideoGeneratePanel, and no
    // wording to translate. What it costs follows the prompt, so the container
    // works the figure out and this prints it.
    renderPanel(<AudioGeneratePanel {...BASE} creditEstimate={20} />);
    expect(screen.getByTestId('generate-audio-rate')).toHaveTextContent('20');
    expect(screen.getByTestId('generate-audio-rate').textContent).not.toMatch(
      /[a-zA-Z]/,
    );
  });

  it('prints a zero before anything is typed, rather than going away', () => {
    renderPanel(<AudioGeneratePanel {...BASE} creditEstimate={0} />);
    expect(screen.getByTestId('generate-audio-rate')).toHaveTextContent('0');
  });

  it('says nothing where the model declares no rate', () => {
    renderPanel(
      <AudioGeneratePanel
        {...BASE}
        models={[ttsModel('no-rate')]}
        currentModel={ttsModel('no-rate')}
        model='no-rate'
        creditEstimate={undefined}
      />,
    );
    expect(screen.queryByTestId('generate-audio-rate')).toBeNull();
  });
});

describe('AudioGeneratePanel execute button (#1960 A12)', () => {
  it('stays pressable when a voice is still to be picked', () => {
    // The refusal is one the user can act on, so the button says what is
    // missing rather than going grey with nothing to explain it.
    renderPanel(<AudioGeneratePanel {...BASE} executeRefusal='voice-missing' />);
    expect(screen.getByTestId('generate-audio-execute')).not.toBeDisabled();
  });

  it('greys out for a refusal the user cannot act on', () => {
    // `no-model` is an environment fact: no amount of typing changes it, so
    // there is nothing for a pressable button to say.
    renderPanel(<AudioGeneratePanel {...BASE} executeRefusal='no-model' />);
    expect(screen.getByTestId('generate-audio-execute')).toBeDisabled();
  });

  it('spins while a submit is in flight', () => {
    renderPanel(<AudioGeneratePanel {...BASE} executeRefusal='submitting' />);
    expect(
      screen.getByTestId('generate-audio-execute-pending'),
    ).toBeInTheDocument();
  });
});

describe('AudioGeneratePanel — reference material (#1960 A16)', () => {
  // An audio node's only accepted input is a text one
  // (`lib/connection-rules.ts:30`), and a text row is prompt material — so a
  // line already written on the canvas becomes the lines to speak.
  const TEXT_ROW = {
    refId: 'e1',
    sourceNodeId: 'src',
    sourceNodeType: 'text' as const,
    sourceNodeName: 'The script',
    thumbnail: undefined,
    content: 'Good evening.',
  };

  it('carries the Reference tool in the top row', () => {
    renderPanel(<AudioGeneratePanel {...BASE} />);
    expect(screen.getByTestId('generate-audio-tool-reference')).toBeInTheDocument();
  });

  it('starts the reference pick, and highlights while it runs', () => {
    const onAddReference = vi.fn();
    renderPanel(
      <AudioGeneratePanel {...BASE} onAddReference={onAddReference} referencePicking />,
    );
    const tool = screen.getByTestId('generate-audio-tool-reference');
    fireEvent.click(tool);
    expect(onAddReference).toHaveBeenCalledTimes(1);
    expect(tool).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the collected rows in the rail', () => {
    renderPanel(<AudioGeneratePanel {...BASE} references={[TEXT_ROW]} />);
    expect(screen.getByTestId('generate-reference-rail')).toBeInTheDocument();
    expect(screen.getByTestId('generate-ref-e1')).toHaveTextContent('The script');
  });

  it('inserts a row into the prompt at the caret', () => {
    const onInsertReference = vi.fn();
    renderPanel(
      <AudioGeneratePanel
        {...BASE}
        references={[TEXT_ROW]}
        onInsertReference={onInsertReference}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ref-insert-e1'));
    expect(onInsertReference).toHaveBeenCalledWith(TEXT_ROW);
  });

});

describe('AudioGeneratePanel — speaking params (#1960 A15)', () => {
  const WITH_PARAMS = {
    ...ELEVEN,
    params: {
      // The shape elevenlabs.yaml declares: a continuous range, which the
      // panel renders as a slider with the vendor's three named stops beneath
      // it. A list of values here would be a model no catalog ships.
      stability: { description: '', min: 0, max: 1, step: 0.05, default: 0.5 },
    },
  };

  it('offers the params picker for a model that declares one', () => {
    renderPanel(
      <AudioGeneratePanel
        {...BASE}
        models={[WITH_PARAMS]}
        currentModel={WITH_PARAMS}
        model={WITH_PARAMS.name}
      />,
    );
    expect(screen.getByTestId('generate-audio-params-trigger')).toBeInTheDocument();
  });

  it('offers none for a model that declares nothing it can show', () => {
    renderPanel(<AudioGeneratePanel {...BASE} />);
    expect(screen.queryByTestId('generate-audio-params-trigger')).toBeNull();
  });

  it('reports a changed param', () => {
    const onChangeParams = vi.fn();
    renderPanel(
      <AudioGeneratePanel
        {...BASE}
        models={[WITH_PARAMS]}
        currentModel={WITH_PARAMS}
        model={WITH_PARAMS.name}
        onChangeParams={onChangeParams}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-audio-params-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-stability-stop-1'));
    expect(onChangeParams).toHaveBeenCalledWith({ stability: 1 });
  });
});

describe('AudioGeneratePanel on a node built before generation (#1960 A13)', () => {
  it('says the node is too old, and offers nothing but the way out', () => {
    // Audio joined GENERATIVE_MODALITIES on this branch, so every audio node
    // made before it has no prompt container and can never generate. The panel
    // states that once; a control that changes nothing would argue with it.
    const textRow = {
      refId: 'e1',
      sourceNodeId: 'src',
      sourceNodeType: 'text' as const,
      sourceNodeName: 'The script',
      thumbnail: undefined,
      content: 'Good evening.',
    };
    renderPanel(
      <AudioGeneratePanel {...BASE} references={[textRow]} promptSlot={null} />,
    );
    expect(screen.getByTestId('generate-audio-legacy')).toHaveTextContent(
      'canvas.generatePanel.audioLegacyNoPrompt',
    );
    expect(screen.getByTestId('generate-audio-exit')).toBeInTheDocument();
    for (const gone of [
      'prompt-editor',
      'generate-audio-tool-reference',
      'generate-ref-insert-e1',
      'generate-audio-mode-trigger',
      'generate-model-trigger',
      'generate-voice-trigger',
      'generate-audio-params-trigger',
      'generate-audio-rate',
      'generate-audio-execute',
    ]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });
});
