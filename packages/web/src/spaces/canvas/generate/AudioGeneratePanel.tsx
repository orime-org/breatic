// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowUp, Loader2, Star, X } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry, ModelRate, Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { AudioGenerateToolbar } from '@web/spaces/canvas/generate/AudioGenerateToolbar';
import {
  AudioParamsPicker,
  type AudioParamsValue,
} from '@web/spaces/canvas/generate/AudioParamsPicker';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import {
  isExecuteButtonDisabled,
  type ExecuteRefusal,
} from '@web/spaces/canvas/generate/generate-guards';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { ModeToggle, type ModeOption } from '@web/spaces/canvas/generate/ModeToggle';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';
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
  /**
   * The selected model's entry, resolved by the view model.
   *
   * Handed down rather than looked up again here: the view model already
   * resolved it to answer which params to render and whether a voice is
   * needed, and a second lookup is a second chance to answer differently.
   */
  currentModel: ModelEntry | undefined;
  /** Whether that model consumes the prompt (its `takes_prompt`). */
  modelTakesPrompt: boolean;
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
  /** The node's derived reference rows (from `deriveReferences`). */
  references: ReferenceRailItem[];
  /** Whether the reference pick is running — highlights the tool. */
  referencePicking?: boolean;
  /** Everything the node holds for the active model, the voice id included. */
  params: Record<string, unknown>;
  /** Enter / exit the reference pick. */
  onAddReference: () => void;
  /** Remove one reference row. */
  onRemoveReference: (item: ReferenceRailItem) => void;
  /** Insert a row's @-mention into the prompt at the caret. */
  onInsertReference: (item: ReferenceRailItem) => void;
  /** A speaking param changed. */
  onChangeParams: (partial: AudioParamsValue) => void;
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
 * @param root0.currentModel - That model's catalog entry.
 * @param root0.modelTakesPrompt - Whether it consumes the prompt.
 * @param root0.mode - The selected mode.
 * @param root0.modeOptions - The modes to offer.
 * @param root0.voiceList - Where the voice list is.
 * @param root0.voiceSelectedId - The stored voice id.
 * @param root0.voiceSelectedName - That voice's name, once known.
 * @param root0.executeRefusal - Which execute precondition fails.
 * @param root0.promptSlot - The injected prompt editor, or null.
 * @param root0.references - The derived reference rows.
 * @param root0.referencePicking - Whether the reference pick is running.
 * @param root0.params - Everything the node holds for the active model.
 * @param root0.onAddReference - Called to enter / exit the reference pick.
 * @param root0.onRemoveReference - Called to remove a row.
 * @param root0.onInsertReference - Called to insert a row into the prompt.
 * @param root0.onChangeParams - Called with the changed speaking param.
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
  currentModel,
  modelTakesPrompt,
  mode,
  modeOptions,
  voiceList,
  voiceSelectedId,
  voiceSelectedName,
  executeRefusal,
  promptSlot,
  references,
  referencePicking = false,
  params,
  onAddReference,
  onRemoveReference,
  onInsertReference,
  onChangeParams,
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
  const rate = currentModel?.rate;

  const exitButton = (
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
  );

  // Audio joined GENERATIVE_MODALITIES on this slice, and only nodes that can
  // generate are born with a prompt container — so every audio node made
  // before it has none and can never generate, however the panel is set up.
  // The sentence is the whole panel: a picker or a rail beside it would offer
  // work that changes nothing, and argue with what the sentence just said
  // (user 2026-09-02).
  if (promptSlot === null) {
    return (
      <div className='flex w-[min(600px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
        <div className='flex items-start justify-between gap-2'>
          <p
            data-testid='generate-audio-legacy'
            className='py-1 text-sm text-muted-foreground'
          >
            {t('canvas.generatePanel.audioLegacyNoPrompt')}
          </p>
          {exitButton}
        </div>
      </div>
    );
  }

  return (
    <div className='flex w-[min(600px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
      <div className='flex items-start justify-between'>
        <AudioGenerateToolbar
          onReference={onAddReference}
          referenceActive={referencePicking}
        />
        {exitButton}
      </div>

      <ReferenceRail
        references={references}
        onRemove={onRemoveReference}
        onInsert={onInsertReference}
        // An audio node collects only text rows, and a text row is prompt
        // material — outside the `modeTakesReferences` question entirely. What
        // it answers to is the model's own `takes_prompt`, resolved once by the
        // view model.
        modelTakesPrompt={modelTakesPrompt}
      />

      {promptSlot}

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
        {currentModel ? (
          // Renders nothing when this model declares no param it can show, so
          // there is no second copy here of what it already decides.
          <AudioParamsPicker
            model={currentModel}
            value={params}
            onChange={onChangeParams}
          />
        ) : null}

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
