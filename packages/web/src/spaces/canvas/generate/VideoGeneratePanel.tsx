// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ArrowUp, Loader2, Star, X } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import {
  isExecuteButtonDisabled,
  type ExecuteRefusal,
} from '@web/spaces/canvas/generate/generate-guards';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { ModeToggle } from '@web/spaces/canvas/generate/ModeToggle';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';
import { VideoGenerateToolbar } from '@web/spaces/canvas/generate/VideoGenerateToolbar';
import type {
  VideoSlot,
  VideoSlotUrls,
} from '@web/spaces/canvas/generate/video-slots';
import {
  VIDEO_MODE_OPTIONS,
  modeTakesReferences,
} from '@web/spaces/canvas/generate/video-mode-options';
import {
  VideoParamsPicker,
  videoParamsPickerHasOptions,
  type VideoParamsValue,
} from '@web/spaces/canvas/generate/VideoParamsPicker';

interface VideoGeneratePanelProps {
  /** Catalog video models, already narrowed to the active mode. */
  models: ModelEntry[];
  /** Current model id. */
  model: string;
  /** Current parameter selection. */
  params: VideoParamsValue;
  /** Estimated credit cost of one generation (current model's cost_per_call). */
  creditEstimate: number;
  /** The active generation mode. */
  mode: string;
  /** Switch generation mode. */
  onToggleMode: (mode: string) => void;
  /** Disable the mode switch while the catalog is empty (no model to switch TO). */
  catalogEmpty: boolean;
  /**
   * Whether the active model consumes the prompt (#1966). Two things read it:
   * the prompt slot (a sentence stands in for the editor when it is false) and
   * the reference rail.
   *
   * In the rail it freezes INSERT on every row — nothing can be inserted into
   * a prompt that is not sent — and the ✕ on TEXT rows only. A text row lives
   * in the prompt, so removing it under a mode that sends none would take it
   * out of the prompt every other mode shares; a media row answers to
   * `modeTakesReferences` instead, because that is the question whose answer
   * points at a mode where the row actually works.
   */
  promptRequired: boolean;
  /** Reference rows derived from this node's incoming edges. */
  references: ReferenceRailItem[];
  /** Enter / exit the canvas reference pick. */
  onAddReference: () => void;
  /** Whether the reference pick is running. */
  referencePicking: boolean;
  /** Remove one reference (deletes its edge). */
  onRemoveReference: (item: ReferenceRailItem) => void;
  /** Insert one reference as an `@` chip in the prompt. */
  onInsertReference: (item: ReferenceRailItem) => void;
  /** The source slots the active mode collects, in display order. */
  slots: readonly VideoSlot[];
  /** What is picked, by slot. */
  slotUrls: VideoSlotUrls;
  /** What to show for each pick, by slot (a poster where the asset cannot paint itself). */
  slotThumbnails: VideoSlotUrls;
  /** The slot whose pick is running, if any. */
  activeSlot?: VideoSlot;
  /** Enter / exit a slot's pick. */
  onPickSlot: (slot: VideoSlot) => void;
  /** Clear a slot. */
  onClearSlot: (slot: VideoSlot) => void;
  /**
   * Which execute precondition fails, or null when Generate may proceed.
   *
   * The panel is one of the two consumers of that answer, and it reads it for
   * a narrower question than the submit path does: which refusals grey the
   * button out, and which one puts a spinner in it. Both questions are
   * answered here rather than by a pair of booleans from the container, so
   * "clickable" and "in flight" can never disagree about the same state.
   */
  executeRefusal: ExecuteRefusal | null;
  /** The collaborative prompt editor, injected by the container (TipTap + Yjs). */
  promptSlot: React.ReactNode;
  /** Close the panel without generating. */
  onExit: () => void;
  /** Pick a model. */
  onSelectModel: (modelId: string) => void;
  /** Change one parameter. */
  onChangeParams: (partial: VideoParamsValue) => void;
  /**
   * Execute: submit the task (the panel closes on success). The node does NOT
   * enter handling here — the server publishes handling only after it accepts
   * and locks the node, so a rejected submit leaves the node untouched and the
   * failure surfaces as a toast.
   */
  onExecute: () => void;
}

/**
 * The video-node Generate panel: the injected collaborative prompt editor over
 * a footer carrying the model picker, the parameter picker, the credit estimate
 * and the submit button.
 *
 * Its own component rather than a mode of the image panel (user 2026-08-08):
 * the two share no parameters, and what they do share — the model picker, the
 * option groups, the prompt editor — is already shared a level below.
 * Presentational throughout; every piece of node data and every Yjs write is
 * threaded in by the container.
 * @param root0 - Component props.
 * @returns The video Generate panel.
 */
export const VideoGeneratePanel = React.memo(function VideoGeneratePanel({
  models,
  model,
  params,
  creditEstimate,
  mode,
  onToggleMode,
  catalogEmpty,
  promptRequired,
  references,
  onAddReference,
  referencePicking,
  onRemoveReference,
  onInsertReference,
  slots,
  slotUrls,
  slotThumbnails,
  activeSlot,
  onPickSlot,
  onClearSlot,
  executeRefusal,
  promptSlot,
  onExit,
  onSelectModel,
  onChangeParams,
  onExecute,
}: VideoGeneratePanelProps): React.JSX.Element {
  const t = useTranslation();
  const currentModel = models.find((m) => m.name === model);
  return (
    <div className='flex w-[min(600px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
      <div className='flex items-start justify-between'>
        <VideoGenerateToolbar
          onReference={onAddReference}
          referenceActive={referencePicking}
          slots={slots}
          slotUrls={slotUrls}
          slotThumbnails={slotThumbnails}
          activeSlot={activeSlot}
          onPickSlot={onPickSlot}
          onClearSlot={onClearSlot}
        />
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-video-exit'
          aria-label={t('canvas.generatePanel.exit')}
          onClick={onExit}
          className='flex h-7 w-7 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-4 w-4' aria-hidden='true' />
        </Button>
      </div>

      <ReferenceRail
        references={references}
        onRemove={onRemoveReference}
        onInsert={onInsertReference}
        // Reference-to-video is the only mode that reads the pool — the other
        // five take their sources from slots or take none (#1903, landed with
        // #1927). So the reference material rows go dark in five of six, which
        // also freezes their ✕: references are shared across modes, and a ✕
        // pressed here would throw away a source the user is coming back for
        // (decision 2026-08-11). A text row is prompt material, so this
        // question leaves it alone — the one below is the one that reaches it,
        // and in talking head (the only mode whose model sends no prompt) it
        // dims and freezes there too (#1966).
        modeTakesReferences={modeTakesReferences(mode)}
        modelTakesPrompt={promptRequired}
      />

      {promptSlot}

      <div className='flex items-center gap-1.5'>
        <ModeToggle
          value={mode}
          options={VIDEO_MODE_OPTIONS}
          onChange={onToggleMode}
          triggerTestId='generate-video-mode-trigger'
          disabled={catalogEmpty}
        />
        <ModelPicker models={models} value={model} onChange={onSelectModel} />
        {currentModel && videoParamsPickerHasOptions(currentModel) ? (
          <VideoParamsPicker
            model={currentModel}
            value={params}
            onChange={onChangeParams}
          />
        ) : null}

        <div className='ml-auto flex items-center gap-1.5'>
          <span
            data-testid='generate-video-credit'
            className='flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground'
          >
            <Star className='h-3.5 w-3.5' aria-hidden='true' />
            {creditEstimate}
          </span>
          <Button
            type='button'
            variant={null}
            size={null}
            data-testid='generate-video-execute'
            aria-label={t('canvas.generatePanel.execute')}
            disabled={isExecuteButtonDisabled(executeRefusal)}
            onClick={onExecute}
            className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
          >
            {executeRefusal === 'submitting' ? (
              <Loader2
                data-testid='generate-video-execute-pending'
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
