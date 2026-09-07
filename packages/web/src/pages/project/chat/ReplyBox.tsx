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
 * The size the boxes a reply opens are drawn at.
 *
 * 520 is the width this project's dialogs are already drawn at; the height is
 * this box's own, chosen for the stage a picture is shown on and the list of
 * sources that shares the component. The viewport cap stops a window shorter
 * than 560 from putting the footer past the bottom edge.
 */
const BOX_SIZE = 'h-[560px] max-h-[calc(100vh-2rem)] w-[520px]';

interface ReplyBoxProps {
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
 * A box for the things a reply found.
 *
 * One size whatever the agent column is doing: what the reader opened it from
 * is in that column, and the thing they opened it to look at is not -- a
 * picture at full size and a list of addresses each want the room they want.
 * That is the whole of the visual difference from the project's ordinary
 * dialog. Escape, the backdrop and the focus trap are the primitive's, and
 * they are the reason a box drawn by hand was wrong; handing focus back is
 * the one part it cannot do here, since it restores focus by focusing its own
 * `Trigger` and this box is opened from state instead -- `useReturnFocus` is
 * that half, which is why the size is not the only thing passed down.
 * @param root0 - The component props.
 * @param root0.open - Whether the box is up.
 * @param root0.onOpenChange - Called when the reader shuts it.
 * @param root0.title - What the box is showing.
 * @param root0.testId - Marks the box for the tests.
 * @param root0.children - The body.
 * @param root0.footer - An optional strip along the bottom.
 * @returns The box.
 */
export function ReplyBox({
  open,
  onOpenChange,
  title,
  testId,
  children,
  footer,
}: ReplyBoxProps): React.JSX.Element {
  const returnFocus = useReturnFocus(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={testId}
        onCloseAutoFocus={returnFocus}
        className={BOX_SIZE}
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
