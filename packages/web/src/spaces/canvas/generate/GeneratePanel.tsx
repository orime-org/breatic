// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowUp, Loader2, Star, X } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry, ReferenceKind } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import {
  isExecuteButtonDisabled,
  type ExecuteRefusal,
} from '@breatic/shared';
import type { CameraValue } from '@web/spaces/canvas/generate/CameraPicker';
import { GenerateToolbar } from '@web/spaces/canvas/generate/GenerateToolbar';
import { ImageModeToggle } from '@web/spaces/canvas/generate/ImageModeToggle';
import type { ModeOption } from '@web/spaces/canvas/generate/ModeToggle';
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
   * The modes this deployment can serve, in display order (#1951) — a mode
   * with no model is not offered at all. The panel only renders when this is
   * non-empty: `CatalogGatedFrame` holds it shut otherwise.
   */
  modeOptions: ReadonlyArray<ModeOption>;
  /**
   * Whether the active model consumes the prompt (#1966). Two things read it:
   * the prompt slot (a sentence stands in for the editor when it is false) and
   * the reference rail.
   *
   * In the rail it refuses INSERT on every row — nothing can be inserted into
   * a prompt that is not sent — and so dims every row's CONTENT, text included.
   * The ✕ is untouched: it removes in every state (#1952). A media row's
   * content is dimmed by `referenceKinds` as well, because that is the
   * question whose answer points at a mode where the row actually works.
   */
  promptRequired: boolean;
  /** Current ratio + resolution selection. */
  params: { aspect_ratio?: string; resolution?: string } & CameraValue & Readonly<Record<string, unknown>>;
  /** The node's derived reference rows. */
  references: ReferenceRailItem[];
  /** The kinds the active model's pool takes in this mode (#2156). */
  referenceKinds: readonly ReferenceKind[];
  /** The run's estimate as printed beside the star; undefined until it resolves. */
  creditText: string | undefined;
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
  /** Close the panel without generating (exit button). */
  onExit: () => void;
  /** Pick a model. */
  onSelectModel: (modelId: string) => void;
  /** Switch the generation sub-mode (t2i / i2i). */
  onToggleMode: (mode: ImageGenMode) => void;
  /** Change ratio / resolution. */
  onChangeParams: (partial: object) => void;
  /** Toggle the canvas reference-pick mode (enter, or exit when already picking). */
  onAddReference: () => void;
  /** Whether THIS node's reference pick is running — highlights the button. */
  referencePicking: boolean;
  /** Remove a rail row (routed by the row's identity — crop vs edge). */
  onRemoveReference: (item: ReferenceRailItem) => void;
  /** Insert a reference's @-mention into the prompt at the cursor (rail click). */
  onInsertReference: (item: ReferenceRailItem) => void;
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

/**
 * The image-node Generate panel (slice 1). Composes the tool row, reference
 * rail, the injected collaborative prompt editor, and a footer (model +
 * ratio/resolution pickers, the
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
  modeOptions,
  promptRequired,
  params,
  references,
  referenceKinds,
  creditText,
  executeRefusal,
  promptSlot,
  onExit,
  onSelectModel,
  onToggleMode,
  onChangeParams,
  onAddReference,
  referencePicking,
  onRemoveReference,
  onInsertReference,
  onFocus,
  focusPicking,
  pendingFocus,
  onExecute,
}: GeneratePanelProps): React.JSX.Element {
  const t = useTranslation();
  const currentModel = models.find((m) => m.name === model);
  // Text-to-image generates from scratch and ignores SOURCE IMAGES (§2.5).
  // Nothing that COLLECTS one is refused for it: the Reference and Focus
  // buttons are live in both modes, and neither pick scopes by mode — the
  // reference one stopped in #1797, the focus one never did. The scoping
  // happens where the image would be USED — the rail dims the CONTENT of its
  // reference rows and refuses their insert (#1952 — their ✕ stays live), and
  // the @-picker hides them. Every refusal therefore sits on the row, which
  // can say why this mode has no use for it; an entry that goes dark can only
  // swallow the click (#1986, user 2026-08-19). The model's pool says which
  // kinds it uses (#2156).
  return (
    <div className='flex w-[min(600px,92vw)] flex-col gap-2.5 rounded-overlay border border-border bg-popover p-3 text-popover-foreground shadow-md'>
      <div className='flex items-start justify-between'>
        <GenerateToolbar
          onReference={onAddReference}
          referenceActive={referencePicking}
          onFocus={onFocus}
          focusActive={focusPicking}
        />
        <div className='flex items-center gap-1.5'>
          <Button
            type='button'
            variant={null}
            size={null}
            data-testid='generate-exit'
            aria-label={t('canvas.generatePanel.exit')}
            onClick={onExit}
            className='flex h-6 w-6 items-center justify-center rounded-overlay text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          >
            <X className='h-3.5 w-3.5' aria-hidden='true' />
          </Button>
        </div>
      </div>

      <ReferenceRail
        references={references}
        onRemove={onRemoveReference}
        onInsert={onInsertReference}
        // Rows of a kind the selected model's pool does not take go dark: a
        // text-to-image model reads no source images at all. Their ✕ does
        // not — references are shared across modes and models, and a row this
        // model cannot use is exactly a row the user may want to clear (user
        // 2026-08-19). A text row stays lit either way: it feeds the prompt
        // string. What could dim it is the prop below, and no model this panel
        // offers declares `takes_prompt: false` — the image models that do
        // (`crystal-upscaler`, `bria-remove-background`) serve `upscale` and
        // `remove_bg`, neither of which is in `IMAGE_MODE_OPTIONS`.
        referenceKinds={referenceKinds}
        modelTakesPrompt={promptRequired}
        pendingFocus={pendingFocus}
      />

      {promptSlot}

      <div className='flex items-center gap-1.5'>
        <ImageModeToggle
          value={mode}
          onChange={onToggleMode}
          options={modeOptions}
        />
        <ModelPicker models={models} value={model} onChange={onSelectModel} />
        {currentModel ? (
          <RatioResolutionPicker
            model={currentModel}
            value={params}
            onChange={onChangeParams}
          />
        ) : null}

        <div className='ml-auto flex items-center gap-1.5'>
          {creditText !== undefined && (
            <span
              data-testid='generate-credit'
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
            data-testid='generate-execute'
            aria-label={t('canvas.generatePanel.execute')}
            disabled={isExecuteButtonDisabled(executeRefusal)}
            onClick={onExecute}
            className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
          >
            {executeRefusal === 'submitting' ? (
              <Loader2
                data-testid='generate-execute-pending'
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
