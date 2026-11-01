// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { useTranslation } from '@web/i18n/use-translation';
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
 * The canvas keyboard shortcuts and pointer gestures, grouped, with the keys
 * written for the reader's platform the way the context-menu hints are.
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
        className='max-w-[440px]'
      >
        <DialogHeader>
          <DialogTitle>{t('canvas.shortcuts.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className='gap-4 pb-4 pt-0'>
          {visibleShortcutGroups(readOnly).map((group) => (
            <section key={group.id} className='flex flex-col'>
              <h3 className='px-2 pb-1 text-xs font-medium text-muted-foreground'>{t(group.titleKey)}</h3>
              {group.rows.map((row) => (
                <div
                  key={row.id}
                  data-testid={`shortcut-row-${row.id}`}
                  className='flex h-8 items-center justify-between gap-4 rounded-chrome px-2 text-sm'
                >
                  <span>{t(row.labelKey)}</span>
                  <span
                    data-testid={`shortcut-keys-${row.id}`}
                    className='whitespace-nowrap text-xs tracking-widest text-muted-foreground'
                  >
                    {formatKeys(row, t)}
                  </span>
                </div>
              ))}
            </section>
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
