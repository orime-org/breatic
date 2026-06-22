// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { MODALITY_ICONS } from '@web/spaces/canvas/nodes/_shared/modality';
import type { Modality } from '@web/spaces/canvas/types/node-view';

interface NodePlaceholderProps {
  modality: Modality;
  /**
   * Optional override (e.g. "Generating cover…" while AI runs). Shown as a
   * single line, replacing the default two-line hint.
   */
  hint?: string;
  /** Double-click handler for the call-to-action (upload a file / write). */
  onActivate?: () => void;
}

/**
 * Empty-state body shown when a content node has no `content` / `url` yet. Two
 * lines: the modality's primary double-click action (upload / write), then a
 * shared, dimmer hint pointing at the right-click menu (generate & more). Both
 * lines are i18n keys. A single click selects the node; only a **double**-click
 * fires `onActivate` (matching the "Double-click to…" copy). An explicit `hint`
 * (e.g. an in-progress status) overrides both lines with one line.
 * @param root0 - Node placeholder props.
 * @param root0.modality - Node modality, selecting the icon and the primary-line copy.
 * @param root0.hint - Optional single-line override (status text).
 * @param root0.onActivate - Called on double-click to upload a file / enter edit.
 * @returns The empty-state call-to-action button.
 */
export function NodePlaceholder({
  modality,
  hint,
  onActivate,
}: NodePlaceholderProps): React.JSX.Element {
  const t = useTranslation();
  const Icon = MODALITY_ICONS[modality];
  return (
    <button
      type='button'
      onDoubleClick={onActivate}
      data-testid='node-placeholder'
      data-modality={modality}
      className='flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground hover:text-foreground'
    >
      <Icon className='h-5 w-5 opacity-70' aria-hidden='true' />
      {hint ? (
        <span className='text-xs'>{hint}</span>
      ) : (
        <span className='flex flex-col gap-0.5'>
          <span className='text-xs'>{t(`canvas.nodePlaceholder.${modality}`)}</span>
          <span className='text-2xs text-muted-foreground/70'>
            {t('canvas.nodePlaceholder.rightClickHint')}
          </span>
        </span>
      )}
    </button>
  );
}
