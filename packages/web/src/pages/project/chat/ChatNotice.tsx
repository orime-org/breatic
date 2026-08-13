// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { Button } from '@web/components/ui/button';

interface ChatNoticeProps {
  /** What to say, or nothing when there is nothing to say. */
  message: string | null;
  /**
   * The way back out of what just failed, when this failure has one here.
   *
   * Most do not: a message that would not send hands the words back to the
   * composer, and reaching further back leaves its own button where it was,
   * so in both cases trying again is pressing something the reader already
   * knows about. A chat that would not open is the one with nothing left on
   * screen to press, which is why it is the one that brings its own.
   */
  action?: { label: string; onClick: () => void };
}

/**
 * The one place the chat panel says something went wrong.
 *
 * It sits on the top edge of the composer, which is where the reader was
 * looking when they pressed send, and it belongs to this column rather than
 * to the whole window — the canvas on the right has its own concerns and a
 * message about a chat that could not be opened has nothing to do with them.
 * Every failure the panel can report comes through here: the send that never
 * left, the one the server refused, the chat that would not open. There is no
 * second channel and nothing here is temporary.
 *
 * Announced, because for a screen reader it is the only channel: a bubble
 * that never appears and a stop button that turns back into send are both
 * things you can only see.
 * @param root0 - The component props.
 * @param root0.message - What to say, or nothing.
 * @param root0.action - The way back out of this failure, when it needs one.
 * @returns The notice, or nothing when there is nothing to say.
 */
export function ChatNotice({ message, action }: ChatNoticeProps): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <div
      role='alert'
      data-testid='chat-notice'
      className='mx-2.5 mb-1.5 flex items-start gap-2 rounded-content-sm border border-status-error-border bg-status-error-bg px-2.5 py-2 text-xs leading-relaxed text-status-error-foreground duration-150 animate-in fade-in slide-in-from-bottom-1'
    >
      <span
        aria-hidden='true'
        className='mt-0.5 w-[3px] shrink-0 self-stretch rounded-full bg-status-error'
      />
      <span className='flex-1'>{message}</span>
      {action ? (
        <Button
          variant='outline'
          size='sm'
          className='-my-0.5 h-6 shrink-0 px-2 text-xs'
          onClick={action.onClick}
          data-testid='chat-notice-action'
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
