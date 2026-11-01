// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { formatShortcut, type ShortcutSpec } from '@web/spaces/canvas/format-shortcut';
import {
  visibleShortcutGroups,
  type ShortcutGesture,
  type ShortcutRow,
} from '@web/spaces/canvas/shortcuts/canvas-shortcuts';

interface CanvasShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A read-only member sees only the rows that do something for them. */
  readOnly: boolean;
  /** Where focus goes when the dialog closes; the opener passes `useReturnFocus`. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The canvas keyboard shortcuts and pointer gestures, grouped, two actions to
 * a line, with the keys written for the reader's platform the way the
 * context-menu hints are.
 * @param props - Dialog props.
 * @param props.open - Whether the dialog shows.
 * @param props.onOpenChange - Called when the dialog asks to open or close.
 * @param props.readOnly - Whether the reader cannot edit the canvas.
 * @param props.onCloseAutoFocus - Focus handling on close.
 * @returns The dialog.
 */
export function CanvasShortcutsDialog({
  open,
  onOpenChange,
  readOnly,
  onCloseAutoFocus,
}: CanvasShortcutsDialogProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
        data-testid='canvas-shortcuts-dialog'
        className='w-fit max-w-none'
      >
        <DialogHeader>
          <DialogTitle>{t('canvas.shortcuts.title')}</DialogTitle>
        </DialogHeader>
        {/* One grid for every group, two actions to a line (label, keys,
            label, keys), each column as wide as its longest entry, so the
            columns line up across groups and the dialog is as wide as its
            words in every language. */}
        <DialogBody className='grid grid-cols-[repeat(4,max-content)] items-center gap-x-6 gap-y-0 px-6 pb-4 pt-0'>
          {visibleShortcutGroups(readOnly).map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              <h3
                className={cn(
                  'col-span-full pb-1 text-xs font-medium text-muted-foreground',
                  groupIndex > 0 && 'pt-3',
                )}
              >
                {t(group.titleKey)}
              </h3>
              {group.rows.map((row, rowIndex) => (
                <div key={row.id} data-testid={`shortcut-row-${row.id}`} className='contents'>
                  <span className={cn('flex h-8 items-center text-sm', rowIndex % 2 === 1 && 'pl-6')}>
                    {t(row.labelKey)}
                  </span>
                  <span
                    data-testid={`shortcut-keys-${row.id}`}
                    className='justify-self-end whitespace-nowrap text-xs text-muted-foreground'
                  >
                    {formatKeys(row, t)}
                  </span>
                </div>
              ))}
            </React.Fragment>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Write a row's alternatives for the reader's platform, separated by a slash.
 * @param row - The row.
 * @param t - The translator, for gesture names.
 * @returns The keys text.
 */
function formatKeys(row: ShortcutRow, t: (key: string) => string): string {
  return row.keys
    .map((k) => formatShortcut(isGesture(k) ? { mod: k.mod, shift: k.shift, key: t(k.gestureKey) } : k))
    .join(' / ');
}

/**
 * Tell a pointer gesture from a key chord.
 * @param k - One alternative of a row.
 * @returns Whether it is a gesture.
 */
function isGesture(k: ShortcutSpec | ShortcutGesture): k is ShortcutGesture {
  return 'gestureKey' in k;
}
