// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { formatShortcut, type ShortcutSpec } from '@web/spaces/canvas/format-shortcut';
import {
  visibleShortcutGroups,
  type ShortcutGesture,
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
 * a line, with the keys written for the user's platform the way the
 * context-menu hints are.
 * @param props - Dialog props.
 * @param props.open - Whether the dialog shows.
 * @param props.onOpenChange - Called when the dialog asks to open or close.
 * @param props.readOnly - Whether the user cannot edit the canvas.
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
        className='w-fit max-w-full'
      >
        <DialogHeader>
          <DialogTitle>{t('canvas.shortcuts.title')}</DialogTitle>
        </DialogHeader>
        {/* One grid for every group, two actions to a line (label, keys,
            label, keys), each column as wide as its longest entry, so the
            columns line up across groups and the dialog is as wide as its
            words in every language. When the window is narrower than that,
            the dialog stops at the window and the action names wrap. */}
        <DialogBody className='grid grid-cols-[repeat(4,auto)] items-center gap-x-6 gap-y-0 pb-4 pt-0'>
          {visibleShortcutGroups(readOnly).map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              <h3
                className={cn(
                  'col-span-full pb-1 text-xs font-medium text-foreground-disabled',
                  groupIndex > 0 && 'pt-3',
                )}
              >
                {t(group.titleKey)}
              </h3>
              {group.rows.map((row, rowIndex) => (
                <div key={row.id} data-testid={`shortcut-row-${row.id}`} className='contents'>
                  <span
                    className={cn(
                      'flex min-h-8 items-center text-sm',
                      // A rule before the second pair keeps each key with its own action.
                      rowIndex % 2 === 1 && 'border-l border-border pl-6',
                    )}
                  >
                    {t(row.labelKey)}
                  </span>
                  <span
                    data-testid={`shortcut-keys-${row.id}`}
                    className='justify-self-end whitespace-nowrap text-xs text-muted-foreground'
                  >
                    {row.keys.map((k, i) => (
                      <React.Fragment key={i}>
                        {i > 0 ? ' / ' : null}
                        {isGesture(k) ? <GestureKeys gesture={k} t={t} /> : <Chord spec={k} />}
                      </React.Fragment>
                    ))}
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
 * A key chord, spaced the way the context-menu hints space theirs.
 * @param props - Component props.
 * @param props.spec - The chord.
 * @returns The chord.
 */
function Chord({ spec }: { spec: ShortcutSpec }): React.JSX.Element {
  return <span className='tracking-widest'>{formatShortcut(spec)}</span>;
}

/**
 * A gesture with the modifiers held for it: "⌘ Click" on a Mac (the glyphs
 * stand apart from the word), "Ctrl+Click" elsewhere. Only the modifiers take
 * the chord spacing; the word keeps ordinary spacing.
 * @param props - Component props.
 * @param props.gesture - The gesture.
 * @param props.t - The translator.
 * @returns The gesture.
 */
function GestureKeys({
  gesture,
  t,
}: {
  gesture: ShortcutGesture;
  t: (key: string) => string;
}): React.JSX.Element {
  const word = t(gesture.gestureKey);
  if (gesture.mod !== true && gesture.shift !== true) return <>{word}</>;
  const chord = formatShortcut({ mod: gesture.mod, shift: gesture.shift, key: word });
  const modifiers = chord.slice(0, -word.length);
  return (
    <>
      <span className='tracking-widest'>{modifiers}</span>
      {modifiers.endsWith('+') ? word : ` ${word}`}
    </>
  );
}

/**
 * Tell a pointer gesture from a key chord.
 * @param k - One alternative of a row.
 * @returns Whether it is a gesture.
 */
function isGesture(k: ShortcutSpec | ShortcutGesture): k is ShortcutGesture {
  return 'gestureKey' in k;
}
