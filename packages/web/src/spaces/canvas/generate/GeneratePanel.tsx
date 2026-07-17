// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ArrowUp, Camera, Globe, Languages, Sparkles, Star, X } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { GenerateToolbar } from '@web/spaces/canvas/generate/GenerateToolbar';
import { ImageModeToggle } from '@web/spaces/canvas/generate/ImageModeToggle';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { RatioResolutionPicker } from '@web/spaces/canvas/generate/RatioResolutionPicker';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';

interface GeneratePanelProps {
  /** Catalog image models (already narrowed to the active mode). */
  models: ModelEntry[];
  /** Current model id. */
  model: string;
  /** Active generation sub-mode (drives the t2i / i2i toggle). */
  mode: ImageGenMode;
  /**
   * Whether the GLOBAL generatable catalog is empty (loading / failed / none
   * configured). Gates the mode toggle's disabled state — NOT `models.length`
   * (the active-mode subset), so a node in a mode with zero models can still
   * toggle back to the populated mode.
   */
  catalogEmpty: boolean;
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
  /** Switch the generation sub-mode (t2i / i2i). */
  onToggleMode: (mode: ImageGenMode) => void;
  /** Change ratio / resolution. */
  onChangeParams: (partial: { aspect_ratio?: string; resolution?: string }) => void;
  /** Toggle the canvas reference-pick mode (enter, or exit when already picking). */
  onAddReference: () => void;
  /** Whether THIS node's reference pick is running — highlights the button. */
  referencePicking: boolean;
  /** Remove a rail row (routed by the row's identity — crop vs edge). */
  onRemoveReference: (item: ReferenceRailItem) => void;
  /** Insert a reference's @-mention into the prompt at the cursor (rail click). */
  onInsertReference: (item: ReferenceRailItem) => void;
  /** Toggle the canvas style-pick mode (#1664 — enter, or exit when already picking). */
  onStyle: () => void;
  /** Whether THIS node's style pick is running — highlights the Style button. */
  stylePicking: boolean;
  /** The picked style image URL (pick-time copy) shown in the Style slot (#1664). */
  styleImageUrl?: string;
  /** Clear the picked style image (the Style slot's ✕ badge). */
  onClearStyle: () => void;
  /** Whether the active model takes a style reference (capability gate). */
  styleSupported: boolean;
  /** Toggle the canvas focus-crop mode (#1782 — enter, or exit when already picking). */
  onFocus: () => void;
  /** Whether THIS node's focus pick is running — highlights the Focus button. */
  focusPicking: boolean;
  /** In-flight focus-crop uploads shown as rail placeholders (#1782). */
  pendingFocus?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Execute: submit the task in overwrite mode (the panel closes on success).
   * The node does NOT enter handling here — the server publishes handling only
   * after it accepts + locks the node, so a rejected submit (gate / credits /
   * lock) leaves the node untouched and the failure surfaces as a toast.
   */
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
  mode,
  catalogEmpty,
  params,
  references,
  creditEstimate,
  canExecute,
  promptSlot,
  onExit,
  onSelectModel,
  onToggleMode,
  onChangeParams,
  onAddReference,
  referencePicking,
  onRemoveReference,
  onInsertReference,
  onStyle,
  stylePicking,
  styleImageUrl,
  onClearStyle,
  styleSupported,
  onFocus,
  focusPicking,
  pendingFocus,
  onExecute,
}: GeneratePanelProps): React.JSX.Element {
  const t = useTranslation();
  const currentModel = models.find((m) => m.name === model);
  // Text-to-image generates from scratch and ignores source images (§2.5): the
  // reference add-button is disabled and the rail dims its IMAGE rows (text
  // rows stay insertable — their @-chips still feed the prompt; R3-4 = A).
  const referencesOff = mode === 't2i';
  // shrink-0 keeps the fixed-size footer icons from being squeezed when the
  // pickers' labels run long (the footer row has no flex-wrap by design).
  const placeholderClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border ' +
    'text-muted-foreground opacity-50 cursor-not-allowed';
  return (
    <div className='flex w-[min(600px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
      <div className='flex items-start justify-between'>
        <GenerateToolbar
          onReference={onAddReference}
          referenceActive={referencePicking}
          referenceDisabled={referencesOff}
          onStyle={onStyle}
          styleActive={stylePicking}
          styleThumbnail={styleImageUrl}
          onClearStyle={onClearStyle}
          styleDisabled={!styleSupported}
          onFocus={onFocus}
          focusActive={focusPicking}
          // Focus crops feed the same i2i source pool as references (#1782).
          focusDisabled={referencesOff}
        />
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

      <ReferenceRail
        references={references}
        onRemove={onRemoveReference}
        onInsert={onInsertReference}
        imageRefsDisabled={referencesOff}
        pendingFocus={pendingFocus}
      />

      {promptSlot}

      <div className='flex items-center gap-1.5'>
        <ImageModeToggle
          value={mode}
          onChange={onToggleMode}
          disabled={catalogEmpty}
        />
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
            className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
          >
            <ArrowUp className='h-4 w-4' aria-hidden='true' />
          </button>
        </div>
      </div>
    </div>
  );
});
