// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ArrowUp, Star, X } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import {
  VideoParamsPicker,
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
  /** Whether execute is allowed (the container owns the reasons). */
  canExecute: boolean;
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
  canExecute,
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
      <div className='flex items-start justify-end'>
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

      {promptSlot}

      <div className='flex items-center gap-1.5'>
        <ModelPicker models={models} value={model} onChange={onSelectModel} />
        {currentModel ? (
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
            disabled={!canExecute}
            onClick={onExecute}
            className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
          >
            <ArrowUp className='h-4 w-4' aria-hidden='true' />
          </Button>
        </div>
      </div>
    </div>
  );
});
