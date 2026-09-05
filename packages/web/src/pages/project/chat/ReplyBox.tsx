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
 * Where the boxes a reply opens are drawn, and how big.
 *
 * `top-[84px] left-1` is the conversation list's own origin (`sheet.tsx`'s
 * `left-floating`: the top bar's 40, the agent header's 40, and 4 of gap), so
 * everything this column opens arrives from the same edge at the same place.
 *
 * 520 is the width this project's dialogs are already drawn at; the height is
 * this box's own, chosen for the stage a picture is shown on and the list of
 * sources that shares the component. The viewport cap stops a window shorter
 * than 560 from putting the footer past the bottom edge.
 */
const BOX_PLACE =
  'left-1 top-[84px] h-[560px] max-h-[calc(100vh-100px)] w-[520px] max-w-none translate-x-0 translate-y-0';

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
 * One size whatever the agent column is doing, and out of the same edge as
 * everything else that column opens: what the reader opened it from is in
 * there, while the thing they opened it to look at wants the room it wants --
 * a picture at full size, or a list of addresses.
 * That is the whole of the difference from the project's ordinary dialog, so
 * the size is all this passes; Escape, the backdrop, the focus trap and the
 * return of focus afterwards are the primitive's, and they are the reason a
 * box drawn by hand was wrong.
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
        className={BOX_PLACE}
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
