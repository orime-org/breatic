// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { useReturnFocus } from '@web/lib/overlay-focus';

/**
 * The Agent column, for anything that has to be laid out against it.
 *
 * A dialog is portalled out of the tree it was written in, so the element it
 * lands in is what decides where it can be. Passing the column down as a prop
 * would mean threading it through every bubble and every part in one, for a
 * thing only the boxes below ask for.
 */
const ColumnElement = React.createContext<HTMLElement | null>(null);

/**
 * Publish the column so the boxes in it can cover it.
 * @param root0 - The component props.
 * @param root0.element - The column, once it is in the document.
 * @param root0.children - The column's contents.
 * @returns The children, with the column available to them.
 */
export function ColumnBoxHost({
  element,
  children,
}: {
  element: HTMLElement | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return <ColumnElement.Provider value={element}>{children}</ColumnElement.Provider>;
}

interface ColumnBoxProps {
  /** Whether the box is up. */
  open: boolean;
  /** Called when the reader shuts it -- Escape, the backdrop, or the button. */
  onOpenChange: (open: boolean) => void;
  /** What the box is showing. */
  title: React.ReactNode;
  /** Marks the box for the tests. */
  testId: string;
  /** The body, which takes the room the header leaves. */
  children: React.ReactNode;
  /** An optional strip along the bottom. */
  footer?: React.ReactNode;
}

/**
 * A box over the Agent column, for the things a reply found.
 *
 * Over the column rather than over the window, which is what the demo shows:
 * the reader opened it from something in this column and what is behind it is
 * the rest of the same reply. That is the whole of the difference from the
 * project's ordinary dialog, so the geometry is all this passes -- Escape,
 * the backdrop, the focus trap and the return of focus afterwards are the
 * primitive's, and they are the reason a box drawn by hand was wrong.
 *
 * Falls back to the middle of the window if the column has not been published
 * yet: a box the reader asked for and cannot see is worse than one in the
 * wrong place.
 * @param root0 - The component props.
 * @param root0.open - Whether the box is up.
 * @param root0.onOpenChange - Called when the reader shuts it.
 * @param root0.title - What the box is showing.
 * @param root0.testId - Marks the box for the tests.
 * @param root0.children - The body.
 * @param root0.footer - An optional strip along the bottom.
 * @returns The box.
 */
export function ColumnBox({
  open,
  onOpenChange,
  title,
  testId,
  children,
  footer,
}: ColumnBoxProps): React.JSX.Element {
  const column = React.useContext(ColumnElement);
  const returnFocus = useReturnFocus(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={testId}
        onCloseAutoFocus={returnFocus}
        container={column}
        overlayClassName={column === null ? undefined : 'absolute'}
        className={
          column === null
            ? 'max-h-[80vh]'
            : 'absolute inset-4 w-auto max-w-none translate-x-0 translate-y-0 bg-popover shadow-lg'
        }
      >
        <DialogHeader>
          <DialogTitle className='truncate text-sm font-medium'>{title}</DialogTitle>
        </DialogHeader>
        {children}
        {footer}
      </DialogContent>
    </Dialog>
  );
}
