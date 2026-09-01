// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowUp, Loader2, Star, X } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry, ModelRate, Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import {
  isExecuteButtonDisabled,
  type ExecuteRefusal,
} from '@web/spaces/canvas/generate/generate-guards';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { ModeToggle, type ModeOption } from '@web/spaces/canvas/generate/ModeToggle';
import { VoicePicker } from '@web/spaces/canvas/generate/VoicePicker';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';

/**
 * The i18n key stating a rate in the unit its vendor counts.
 * @param unit - What the vendor bills by.
 * @returns The message key.
 */
function rateKey(unit: ModelRate['unit']): string {
  return unit === 'characters'
    ? 'canvas.generatePanel.rateCharacters'
    : 'canvas.generatePanel.rateBytes';
}

interface AudioGeneratePanelProps {
  /** The tts models this panel offers. */
  models: ModelEntry[];
  /** The selected model id. */
  model: string;
  /** The selected mode. */
  mode: string;
  /** The modes this panel offers, filtered by what the catalog serves. */
  modeOptions: ReadonlyArray<ModeOption>;
  /** Where the voice list is. */
  voiceList: VoiceListState;
  /** The voice held in this model's param record, or null when none is. */
  voiceSelectedId: string | null;
  /** That voice's name once fetched. */
  voiceSelectedName: string | null;
  /**
   * Which execute precondition fails, or null when Generate may proceed. The
   * panel reads it for two questions at once — whether the button is
   * clickable, and whether it spins — so the two can never disagree.
   */
  executeRefusal: ExecuteRefusal | null;
  /**
   * The collaborative prompt editor, injected by the container. Null on a node
   * built before generation reached audio: those have no prompt container in
   * the document, so an editor here would take typing and store none of it.
   */
  promptSlot: React.ReactNode;
  /** Pick a mode. */
  onToggleMode: (mode: string) => void;
  /** Pick a model. */
  onSelectModel: (modelId: string) => void;
  /** The voice list opened or collapsed. */
  onVoiceOpenChange: (open: boolean) => void;
  /** What was typed into the voice search. */
  onVoiceQueryChange: (query: string) => void;
  /** A voice was chosen. */
  onVoicePick: (voice: Voice) => void;
  /** The voice list reached its end. */
  onVoiceLoadMore: () => void;
  /** Close the panel without generating. */
  onExit: () => void;
  /** Submit the task. */
  onExecute: () => void;
}

/**
 * The audio-node Generate panel: the injected collaborative prompt editor over
 * a footer carrying the mode picker, the model picker, the voice picker, the
 * rate and the submit button.
 *
 * The footer states a RATE rather than a total. Both tts vendors bill by how
 * much text is sent, so what a generation costs is not known until it is
 * written, and the unit each counts differs — one per character, the other per
 * UTF-8 byte.
 *
 * Presentational throughout; every piece of node data and every Yjs write is
 * threaded in by the container.
 * @param root0 - Component props.
 * @param root0.models - The tts models to offer.
 * @param root0.model - The selected model id.
 * @param root0.mode - The selected mode.
 * @param root0.modeOptions - The modes to offer.
 * @param root0.voiceList - Where the voice list is.
 * @param root0.voiceSelectedId - The stored voice id.
 * @param root0.voiceSelectedName - That voice's name, once known.
 * @param root0.executeRefusal - Which execute precondition fails.
 * @param root0.promptSlot - The injected prompt editor, or null.
 * @param root0.onToggleMode - Called with the picked mode.
 * @param root0.onSelectModel - Called with the picked model id.
 * @param root0.onVoiceOpenChange - Called when the voice list opens or collapses.
 * @param root0.onVoiceQueryChange - Called with the voice search term.
 * @param root0.onVoicePick - Called with the chosen voice.
 * @param root0.onVoiceLoadMore - Called when the voice list reaches its end.
 * @param root0.onExit - Called to close the panel.
 * @param root0.onExecute - Called to submit.
 * @returns The audio Generate panel.
 */
export const AudioGeneratePanel = React.memo(function AudioGeneratePanel({
  models,
  model,
  mode,
  modeOptions,
  voiceList,
  voiceSelectedId,
  voiceSelectedName,
  executeRefusal,
  promptSlot,
  onToggleMode,
  onSelectModel,
  onVoiceOpenChange,
  onVoiceQueryChange,
  onVoicePick,
  onVoiceLoadMore,
  onExit,
  onExecute,
}: AudioGeneratePanelProps): React.JSX.Element {
  const t = useTranslation();
  const rate = models.find((m) => m.name === model)?.rate;
  return (
    <div className='flex w-[min(600px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
      <div className='flex justify-end'>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-audio-exit'
          aria-label={t('canvas.generatePanel.exit')}
          onClick={onExit}
          className='flex h-7 w-7 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-4 w-4' aria-hidden='true' />
        </Button>
      </div>

      {promptSlot ?? (
        <p
          data-testid='generate-audio-legacy'
          className='px-2.5 py-4 text-sm text-muted-foreground'
        >
          {t('canvas.generatePanel.audioLegacyNoPrompt')}
        </p>
      )}

      <div className='flex items-center gap-1.5'>
        <ModeToggle
          value={mode}
          options={modeOptions}
          onChange={onToggleMode}
          triggerTestId='generate-audio-mode-trigger'
        />
        <ModelPicker models={models} value={model} onChange={onSelectModel} />
        <VoicePicker
          list={voiceList}
          selectedId={voiceSelectedId}
          selectedName={voiceSelectedName}
          onOpenChange={onVoiceOpenChange}
          onQueryChange={onVoiceQueryChange}
          onPick={onVoicePick}
          onLoadMore={onVoiceLoadMore}
        />

        <div className='ml-auto flex items-center gap-1.5'>
          {rate && (
            <span
              data-testid='generate-audio-rate'
              className='flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground'
            >
              <Star className='h-3.5 w-3.5' aria-hidden='true' />
              {t(rateKey(rate.unit), { credits: rate.credits, per: rate.per })}
            </span>
          )}
          <Button
            type='button'
            variant={null}
            size={null}
            data-testid='generate-audio-execute'
            aria-label={t('canvas.generatePanel.execute')}
            disabled={isExecuteButtonDisabled(executeRefusal)}
            onClick={onExecute}
            className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
          >
            {executeRefusal === 'submitting' ? (
              <Loader2
                data-testid='generate-audio-execute-pending'
                className='h-4 w-4 animate-spin'
                aria-hidden='true'
              />
            ) : (
              <ArrowUp className='h-4 w-4' aria-hidden='true' />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
});
