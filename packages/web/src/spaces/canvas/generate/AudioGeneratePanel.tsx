// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowUp, Loader2, Star, X } from 'lucide-react';
import * as React from 'react';

import type { GenerationTemplate, ModelEntry, Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import type {
  AudioSlot,
  AudioSlotUrls,
} from '@web/spaces/canvas/generate/audio-slots';
import { AudioGenerateToolbar } from '@web/spaces/canvas/generate/AudioGenerateToolbar';
import {
  AudioSettingsPicker,
  type VoiceSource,
} from '@web/spaces/canvas/generate/AudioSettingsPicker';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import {
  isExecuteButtonDisabled,
  type ExecuteRefusal,
} from '@breatic/shared';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { ModeToggle, type ModeOption } from '@web/spaces/canvas/generate/ModeToggle';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';
import { NO_REFERENCE_KINDS } from '@web/spaces/canvas/generate/reference-urls';
import { TemplateMenu } from '@web/spaces/canvas/generate/TemplateMenu';

/**
 * The panel's outer surface: width, corners, border, fill, padding, spacing.
 *
 * One constant because this component returns it from two branches — the
 * legacy node's single line and the panel proper — and two literals can drift
 * into two different panels without anything failing.
 */
const SHELL =
  'flex w-[min(600px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md';

interface AudioGeneratePanelProps {
  /** The tts and audio models this panel offers. */
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
  /** The run's estimate as printed beside the star; undefined until it resolves. */
  creditText: string | undefined;
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
  /** The source slots the active mode collects, in display order. */
  slots: readonly AudioSlot[];
  /** What is picked, by slot. */
  slotUrls: AudioSlotUrls;
  /** What to show for each pick, by slot. */
  slotThumbnails: AudioSlotUrls;
  /** The slot whose pick is running, if any. */
  activeSlot?: AudioSlot;
  /** Enter / exit a slot's pick. */
  onPickSlot: (slot: AudioSlot) => void;
  /** Clear a slot. */
  onClearSlot: (slot: AudioSlot) => void;
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
  /**
   * The injected lyrics editor, or null on a mode that collects none (#1960).
   *
   * Its own slot rather than a flag: the editor is a live collaborative view
   * of a Yjs fragment, and the container is the layer that owns those.
   */
  lyricsSlot: React.ReactNode;
  /**
   * The name over the prompt box, or undefined on a mode whose box is the
   * plain prompt. The lyrics box always carries its own.
   */
  promptLabel: string | undefined;
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
  /** One of the model's params changed. */
  onChangeParams: (partial: object) => void;
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
  /** Every model served for the node type: the template menu greys out templates it cannot run (inner#977). */
  catalogModels: readonly ModelEntry[];
  /** Applies a template picked from the corner menu. */
  onPickTemplate: (template: GenerationTemplate) => void;
  /** Submit the task. */
  onExecute: () => void;
}

/**
 * The audio-node Generate panel: the injected collaborative editors over a
 * footer carrying the mode picker, the model picker, the voice-and-settings
 * pill, the credit figure and the submit button.
 *
 * The figure is the run's estimate beside a star, the shape every generate
 * panel uses.
 *
 * Presentational throughout; every piece of node data and every Yjs write is
 * threaded in by the container.
 * @param root0 - Component props.
 * @param root0.models - The tts and audio models to offer.
 * @param root0.model - The selected model id.
 * @param root0.currentModel - That model's catalog entry.
 * @param root0.creditText - The run's estimate as printed beside the star.
 * @param root0.modelTakesPrompt - Whether it consumes the prompt.
 * @param root0.mode - The selected mode.
 * @param root0.modeOptions - The modes to offer.
 * @param root0.voiceList - Where the voice list is.
 * @param root0.voiceSelectedId - The stored voice id.
 * @param root0.voiceSelectedName - That voice's name, once known.
 * @param root0.executeRefusal - Which execute precondition fails.
 * @param root0.promptSlot - The injected prompt editor, or null.
 * @param root0.lyricsSlot - The injected lyrics editor, or null.
 * @param root0.promptLabel - The name over the prompt box, if it has one.
 * @param root0.references - The derived reference rows.
 * @param root0.referencePicking - Whether the reference pick is running.
 * @param root0.slots - The slots the active mode collects.
 * @param root0.slotUrls - What is picked, by slot.
 * @param root0.slotThumbnails - What to show for each pick, by slot.
 * @param root0.activeSlot - The slot whose pick is running.
 * @param root0.onPickSlot - Called to enter / exit a slot's pick.
 * @param root0.onClearSlot - Called to clear a slot.
 * @param root0.params - Everything the node holds for the active model.
 * @param root0.onAddReference - Called to enter / exit the reference pick.
 * @param root0.onRemoveReference - Called to remove a row.
 * @param root0.onInsertReference - Called to insert a row into the prompt.
 * @param root0.onChangeParams - Called with the changed param.
 * @param root0.onToggleMode - Called with the picked mode.
 * @param root0.onSelectModel - Called with the picked model id.
 * @param root0.onVoiceOpenChange - Called when the voice list opens or collapses.
 * @param root0.onVoiceQueryChange - Called with the voice search term.
 * @param root0.onVoicePick - Called with the chosen voice.
 * @param root0.onVoiceLoadMore - Called when the voice list reaches its end.
 * @param root0.onExit - Called to close the panel.
 * @param root0.catalogModels - Every model served for the node type.
 * @param root0.onPickTemplate - Applies a picked template.
 * @param root0.onExecute - Called to submit.
 * @returns The audio Generate panel.
 */
export const AudioGeneratePanel = React.memo(function AudioGeneratePanel({
  models,
  model,
  currentModel,
  creditText,
  modelTakesPrompt,
  mode,
  modeOptions,
  voiceList,
  voiceSelectedId,
  voiceSelectedName,
  executeRefusal,
  promptSlot,
  lyricsSlot,
  promptLabel,
  references,
  referencePicking = false,
  slots,
  slotUrls,
  slotThumbnails,
  activeSlot,
  onPickSlot,
  onClearSlot,
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
  catalogModels,
  onPickTemplate,
  onExecute,
}: AudioGeneratePanelProps): React.JSX.Element {
  const t = useTranslation();
  // One object for the settings pill, rebuilt only when a piece of it moves:
  // the pill is memoised and a fresh literal every render would defeat it.
  const voice = React.useMemo<VoiceSource>(
    () => ({
      list: voiceList,
      selectedId: voiceSelectedId,
      selectedName: voiceSelectedName,
      onOpenChange: onVoiceOpenChange,
      onQueryChange: onVoiceQueryChange,
      onPick: onVoicePick,
      onLoadMore: onVoiceLoadMore,
    }),
    [
      voiceList,
      voiceSelectedId,
      voiceSelectedName,
      onVoiceOpenChange,
      onVoiceQueryChange,
      onVoicePick,
      onVoiceLoadMore,
    ],
  );

  const exitButton = (
    <Button
      type='button'
      variant={null}
      size={null}
      data-testid='generate-audio-exit'
      aria-label={t('canvas.generatePanel.exit')}
      onClick={onExit}
      className='flex h-6 w-6 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
    >
      <X className='h-3.5 w-3.5' aria-hidden='true' />
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
      <div className={SHELL}>
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
    <div className={SHELL}>
      <div className='flex items-start justify-between'>
        <AudioGenerateToolbar
          onReference={onAddReference}
          referenceActive={referencePicking}
          slots={slots}
          slotUrls={slotUrls}
          slotThumbnails={slotThumbnails}
          activeSlot={activeSlot}
          onPickSlot={onPickSlot}
          onClearSlot={onClearSlot}
        />
        <div className='flex items-center gap-1.5'>
          <TemplateMenu nodeType='audio' models={catalogModels} onPick={onPickTemplate} />
          {exitButton}
        </div>
      </div>

      <ReferenceRail
        references={references}
        onRemove={onRemoveReference}
        onInsert={onInsertReference}
        // No audio model declares a reference pool, so the rail turns away
        // every media row here and a text row is the only one that lands —
        // and a text row is prompt material, outside the
        // `referenceKinds` question entirely. What it answers to is the
        // model's own `takes_prompt`, resolved once by the view model.
        referenceKinds={NO_REFERENCE_KINDS}
        modelTakesPrompt={modelTakesPrompt}
      />

      {/* Two boxes look alike once the placeholders are typed over, so each
          carries a word saying which is which. The prompt box is named on a
          mode whose box asks for something other than the plain prompt — a
          music mode's style brief — even under a model that takes no lyrics,
          so the name does not vanish with the second box.

          Both wrappers are here whether or not there is a second box, and the
          labels are holes rather than a second branch: React reconciles by
          position, so a `promptSlot` sitting directly under the panel in one
          branch and under a div in the other is a different element each time
          and gets torn down — taking the editor's collaborative binding, its
          caret and its undo stack with it on any switch that adds or removes
          the lyrics box.

          A label sits 6px above the box it names and 10px below the group
          before it, so the pairing is read off the spacing rather than off the
          order — the weight and the gap the video params popover already gives
          a control's name. */}
      <div className='flex flex-col gap-2.5'>
        <div className='flex flex-col gap-1.5'>
          {promptLabel !== undefined && (
            <span className='text-xs font-medium text-muted-foreground'>{promptLabel}</span>
          )}
          {promptSlot}
        </div>
        {lyricsSlot !== null && (
          <div className='flex flex-col gap-1.5'>
            <span className='text-xs font-medium text-muted-foreground'>
              {t('canvas.generatePanel.musicLyricsLabel')}
            </span>
            {lyricsSlot}
          </div>
        )}
      </div>

      <div className='flex items-center gap-1.5'>
        <ModeToggle
          value={mode}
          options={modeOptions}
          onChange={onToggleMode}
          triggerTestId='generate-audio-mode-trigger'
        />
        <ModelPicker models={models} value={model} onChange={onSelectModel} />
        {currentModel ? (
          // Renders nothing when this model has no voice and no param to show.
          <AudioSettingsPicker
            model={currentModel}
            mode={mode}
            value={params}
            onChange={onChangeParams}
            voice={voice}
          />
        ) : null}

        <div className='ml-auto flex items-center gap-1.5'>
          {creditText !== undefined && (
            <span
              data-testid='generate-audio-rate'
              className='flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground'
            >
              <Star className='h-3.5 w-3.5' aria-hidden='true' />
              {creditText}
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
