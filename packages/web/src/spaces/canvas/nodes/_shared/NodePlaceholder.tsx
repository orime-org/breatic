// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { Button } from '@web/components/ui/button';
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
  /**
   * Fires the call-to-action (upload a file / write): double-click, or Enter /
   * Space while the button has focus.
   */
  onActivate?: () => void;
}

/**
 * Empty-state body shown when a content node has no `content` / `url` yet. Two
 * lines: the modality's primary double-click action (upload / write), then a
 * shared, dimmer hint pointing at the right-click menu (generate & more). Both
 * lines are i18n keys. A single click selects the node; a **double**-click, or
 * Enter / Space on the focused button, fires `onActivate`. An explicit `hint`
 * (e.g. an in-progress status) overrides both lines with one line.
 *
 * The keyboard half is not a bonus feature — `Button` renders a real
 * `<button>`, so it is
 * focusable and clicking an empty node lands focus here
 * rather than on the node wrapper. Without a keyboard path the most common
 * sequence there (click the node, press Enter to start) would do nothing at
 * all, and the node most in need of a way in is exactly the empty one. The
 * browser turns a keyboard activation into a click with no pointer behind it,
 * which is what `detail === 0` means; a real click keeps its count and still
 * only selects the node.
 * @param root0 - Node placeholder props.
 * @param root0.modality - Node modality, selecting the icon and the primary-line copy.
 * @param root0.hint - Optional single-line override (status text).
 * @param root0.onActivate - Called on double-click, or on Enter / Space while
 *   the button has focus, to upload a file / enter edit.
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
    <Button
      type='button'
      // No variant, no size: the node shell already draws this control's
      // frame and the 9th-slice system fixes how a node body answers hover
      // (it brightens its text rather than filling), so every chrome the
      // primitive could add would be a second edge or a wrong hover. The
      // classes below are the whole appearance. NodePlaceholder.test.tsx
      // pins the hover behaviour.
      variant={null}
      size={null}
      onDoubleClick={onActivate}
      onClick={(event) => {
        if (event.detail === 0) onActivate?.();
      }}
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
    </Button>
  );
}
