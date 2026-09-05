// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import type { ChatMessage } from '@web/pages/project/chat/types';

/** How an ending reads: a fault, a ceiling, or neither. */
type Tone = 'neutral' | 'error' | 'warning';

/**
 * One ending line, with whatever move it leaves the reader.
 * @param root0 - What to draw.
 * @param root0.testId - What the test looks it up by.
 * @param root0.text - The line itself.
 * @param root0.tone - How it reads.
 * @param root0.alert - Announce it, for a failure happening right now.
 * @param root0.action - The button, when there is a move to offer.
 * @returns The line.
 */
function EndingLine({
  testId,
  text,
  tone,
  alert,
  action,
}: {
  testId: string;
  text: string;
  tone: Tone;
  alert?: boolean;
  action?: React.JSX.Element;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      {...(alert === true ? { role: 'alert' } : {})}
      className={cn(
        'mt-[0.85em] flex items-center gap-2 text-xs',
        tone === 'error' &&
          'rounded-content-sm border border-status-error-border bg-status-error-bg px-2 py-1 text-status-error-foreground',
        tone === 'warning' &&
          'rounded-content-sm border border-status-warning-border bg-status-warning-bg px-2 py-1 text-status-warning-foreground',
        tone === 'neutral' && 'text-muted-foreground',
      )}
    >
      <span>{text}</span>
      {action}
    </div>
  );
}

interface TurnEndingProps {
  /** The message this ending belongs to. */
  message: ChatMessage;
  /** Run this turn again from the reader's last message. */
  onRetry?: (messageId: string) => void;
  /** Carry on from where the reply stops. */
  onContinue?: (messageId: string) => void;
}

/**
 * One line saying how a turn ended, with whatever move it leaves the reader.
 *
 * Five endings and only three are faults. A turn waiting on an answer is the
 * model doing what it was asked to, so it gets a neutral line and no retry --
 * a button there would offer a way out of nothing. A turn cut off at the
 * output ceiling is offered a way to carry on rather than to start over: what
 * it was saying is still wanted and nothing about it went wrong.
 *
 * A reply with nothing in it is the fifth, and it is a fault the reader can
 * do something about. It is told apart from the waiting one by the mark the
 * server writes, never by reading the tool names -- which tools stop a turn
 * is a list in a package this one may not import.
 * @param root0 - The component props.
 * @param root0.message - The message this ending belongs to.
 * @param root0.onRetry - Run this turn again.
 * @param root0.onContinue - Carry on from where the reply stops.
 * @returns The line, or nothing for a turn that ended with an answer.
 */
export function TurnEnding({
  message,
  onRetry,
  onContinue,
}: TurnEndingProps): React.JSX.Element | null {
  const t = useTranslation();
  const retry = React.useCallback(() => onRetry?.(message.id), [onRetry, message.id]);
  const carryOn = React.useCallback(() => onContinue?.(message.id), [onContinue, message.id]);

  // Nothing is said about how a turn ended while it is still going.
  if (message.streaming === true) return null;

  if (message.failed === true) {
    return (
      <EndingLine
        testId='message-bubble-error'
        text={t('chat.error.turnFailed')}
        tone='error'
        {...(message.failedJustNow === true ? { alert: true } : {})}
        action={onRetry === undefined ? undefined : (
          <Button
            data-testid='turn-retry'
            variant='outline'
            size='sm'
            className='ml-auto h-btn-compact'
            onClick={retry}
          >
            {t('chat.action.retry')}
          </Button>
        )}
      />
    );
  }

  if (message.truncated === true) {
    return (
      <EndingLine
        testId='message-bubble-truncated'
        text={t('chat.message.truncated')}
        tone='warning'
        action={onContinue === undefined ? undefined : (
          <Button
            data-testid='turn-continue'
            variant='outline'
            size='sm'
            className='ml-auto h-btn-compact'
            onClick={carryOn}
          >
            {t('chat.action.continue')}
          </Button>
        )}
      />
    );
  }

  if (message.interrupted === true) {
    return (
      <EndingLine
        testId='message-bubble-interrupted'
        text={t('chat.message.interrupted')}
        tone='neutral'
      />
    );
  }

  if (message.blocked === true) {
    return (
      <EndingLine
        testId='message-bubble-blocked'
        text={t('chat.message.blocked')}
        tone='neutral'
      />
    );
  }

  // Nothing said, and nothing that explains it. The reader's move is to ask
  // again, which is the same mechanism the failure above offers.
  if (message.content === '' && message.role === 'assistant') {
    return (
      <EndingLine
        testId='message-bubble-empty'
        text={t('chat.message.empty')}
        tone='neutral'
        action={onRetry === undefined ? undefined : (
          <Button
            data-testid='turn-retry'
            variant='outline'
            size='sm'
            className='ml-auto h-btn-compact'
            onClick={retry}
          >
            {t('chat.action.retry')}
          </Button>
        )}
      />
    );
  }

  return null;
}
