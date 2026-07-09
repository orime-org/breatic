// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ArrowUp, Camera, Globe, Languages, Sparkles, Star, X } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { GenerateToolbar } from '@web/spaces/canvas/generate/GenerateToolbar';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { RatioResolutionPicker } from '@web/spaces/canvas/generate/RatioResolutionPicker';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

interface GeneratePanelProps {
  /** Catalog image models. */
  models: ModelEntry[];
  /** Current model id. */
  model: string;
  /** Current ratio + resolution selection. */
  params: { aspect_ratio?: string; resolution?: string };
  /** The node's derived reference rows. */
  references: ReferenceRailItem[];
  /** Estimated credit cost of one generation (current model's cost_per_call). */
  creditEstimate: number;
  /** Whether execute is allowed (prompt non-empty). */
  canExecute: boolean;
  /** The collaborative prompt editor, injected by the container (TipTap + Yjs). */
  promptSlot: React.ReactNode;
  /** Close the panel without generating (exit button). */
  onExit: () => void;
  /** Pick a model. */
  onSelectModel: (modelId: string) => void;
  /** Change ratio / resolution. */
  onChangeParams: (partial: { aspect_ratio?: string; resolution?: string }) => void;
  /** Enter the canvas reference-pick mode. */
  onAddReference: () => void;
  /** Remove a reference by id. */
  onRemoveReference: (refId: string) => void;
  /** Execute: close the panel, put the node into handling, submit the task. */
  onExecute: () => void;
}

/** Footer placeholder buttons not yet wired (slice-1 decision B — shown disabled). */
const FOOTER_PLACEHOLDERS = [
  { key: 'presets', testId: 'generate-presets', Icon: Sparkles },
  { key: 'camera', testId: 'generate-camera', Icon: Camera },
  { key: 'translate', testId: 'generate-translate', Icon: Languages },
  { key: 'online', testId: 'generate-online', Icon: Globe },
] as const;

/**
 * The image-node Generate panel (slice 1). Composes the tool row, reference
 * rail, the injected collaborative prompt editor, and a footer (model +
 * ratio/resolution pickers, disabled placeholders for the unbuilt controls, the
 * credit estimate, and the execute button). Presentational: all node data +
 * Yjs writes are threaded in by the container. Count is fixed to 1 (no count
 * control). The exit button only closes; execute is the separate action.
 * @param root0 - Component props.
 * @returns The Generate panel.
 */
export const GeneratePanel = React.memo(function GeneratePanel({
  models,
  model,
  params,
  references,
  creditEstimate,
  canExecute,
  promptSlot,
  onExit,
  onSelectModel,
  onChangeParams,
  onAddReference,
  onRemoveReference,
  onExecute,
}: GeneratePanelProps): React.JSX.Element {
  const t = useTranslation();
  const currentModel = models.find((m) => m.name === model);
  const placeholderClass =
    'flex h-8 w-8 items-center justify-center rounded-full border border-border ' +
    'text-muted-foreground opacity-50 cursor-not-allowed';
  return (
    <div className='flex w-[min(470px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
      <div className='flex items-start justify-between'>
        <GenerateToolbar onReference={onAddReference} />
        <button
          type='button'
          data-testid='generate-exit'
          aria-label={t('canvas.generatePanel.exit')}
          onClick={onExit}
          className='flex h-7 w-7 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-4 w-4' aria-hidden='true' />
        </button>
      </div>

      <ReferenceRail references={references} onRemove={onRemoveReference} />

      {promptSlot}

      <div className='flex items-center gap-1.5'>
        <ModelPicker models={models} value={model} onChange={onSelectModel} />
        {currentModel ? (
          <RatioResolutionPicker
            model={currentModel}
            value={params}
            onChange={onChangeParams}
          />
        ) : null}
        {FOOTER_PLACEHOLDERS.slice(0, 2).map(({ key, testId, Icon }) => (
          <button
            key={key}
            type='button'
            data-testid={testId}
            disabled
            aria-label={t(`canvas.generatePanel.${key}`)}
            className={placeholderClass}
          >
            <Icon className='h-4 w-4' aria-hidden='true' />
          </button>
        ))}

        <div className='ml-auto flex items-center gap-1.5'>
          {FOOTER_PLACEHOLDERS.slice(2).map(({ key, testId, Icon }) => (
            <button
              key={key}
              type='button'
              data-testid={testId}
              disabled
              aria-label={t(`canvas.generatePanel.${key}`)}
              className={placeholderClass}
            >
              <Icon className='h-4 w-4' aria-hidden='true' />
            </button>
          ))}
          <span
            data-testid='generate-credit'
            className='flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground'
          >
            <Star className='h-3.5 w-3.5' aria-hidden='true' />
            {creditEstimate}
          </span>
          <button
            type='button'
            data-testid='generate-execute'
            aria-label={t('canvas.generatePanel.execute')}
            disabled={!canExecute}
            onClick={onExecute}
            className='flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
          >
            <ArrowUp className='h-4 w-4' aria-hidden='true' />
          </button>
        </div>
      </div>
    </div>
  );
});
