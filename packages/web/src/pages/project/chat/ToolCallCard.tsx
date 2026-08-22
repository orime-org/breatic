// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { CircleAlert, CircleCheck, CircleSlash, Loader2 } from 'lucide-react';
import type * as React from 'react';

import { FAILURE_LINES } from '@breatic/shared';

import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import type { ToolCall } from '@web/pages/project/chat/types';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

/**
 * How the card presents the ending, which is not the same set as storage has.
 *
 * Storage has no terminal state for "stopped before it finished", so it keeps
 * one as `error`; a reader has to be told those apart.
 */
type ShownStatus = ToolCall['status'] | 'unfinished';

/**
 * Compact card embedded inside an assistant bubble showing the agent's
 * tool call: name, status icon, and (on success) a small JSON preview.
 * Argument/result detail expansion lands in a later polish PR.
 * @param root0 - The component props.
 * @param root0.toolCall - The tool call to render (name, status, optional error).
 * @returns The compact tool-call card.
 */
export function ToolCallCard({
  toolCall,
}: ToolCallCardProps): React.JSX.Element {
  const t = useTranslation();
  // Storage has no third terminal state, so a call the user stopped mid-flight
  // is kept as `error` and says so alongside. Calling that a failure tells the
  // user something broke when they are the one who stopped it.
  //
  // Two fields can say it and a call arrives with either. A replayed message
  // carries which ending it was; a live one carries only the line, because the
  // wire has one field for a failure and that is what it holds. Reading one
  // field is how the icon came to draw a failure under the word "stopped".
  //
  // Narrowed to `error` on purpose: a call still running is also without an
  // outcome, and that one is the spinner's job, not this line's.
  const unfinished =
    toolCall.status === 'error' &&
    (toolCall.failureKind === 'user_aborted' || toolCall.failureKey === FAILURE_LINES.stopped);
  // One judgement drives everything the card says about how the call ended —
  // the icon, the marker, and the caption. Deciding it separately in each is
  // how the words came to say one thing while the icon said another.
  const shown: ShownStatus = unfinished ? 'unfinished' : toolCall.status;

  return (
    <div
      data-testid='tool-call-card'
      data-status={shown}
      className='mt-2 rounded border border-border bg-background/60 px-2 py-1 text-xs'
    >
      <div className='flex items-center gap-1'>
        <StatusIcon status={shown} />
        <span className='font-mono'>{toolCall.name}</span>
      </div>
      {unfinished ? (
        <div className='mt-1 text-muted-foreground' data-testid='tool-call-unfinished'>
          {t(toolCall.failureKey ?? FAILURE_LINES.stopped)}
        </div>
      ) : toolCall.status === 'error' ? (
        <div
          className='mt-1 text-status-error-foreground'
          data-testid='tool-call-error'
        >
          {t(toolCall.failureKey ?? FAILURE_LINES.generic)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Status icon for a tool call - spinner (pending), check (success), alert
 * (error), or a neutral mark for a call that never finished.
 * @param root0 - The component props.
 * @param root0.status - The tool call status to map to an icon.
 * @returns The icon element for the given status.
 */
function StatusIcon({ status }: { status: ShownStatus }): React.JSX.Element {
  const cls = 'h-3 w-3';
  switch (status) {
    case 'unfinished':
      return <CircleSlash className={cn(cls, 'text-muted-foreground')} />;
    case 'pending':
      return <Loader2 className={cn(cls, 'animate-spin opacity-70')} />;
    case 'success':
      return <CircleCheck className={cn(cls, 'text-status-success')} />;
    case 'error':
      return <CircleAlert className={cn(cls, 'text-status-error')} />;
  }
}
