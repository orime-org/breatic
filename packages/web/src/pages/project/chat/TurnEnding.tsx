// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';

import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import type { ChatMessage } from '@web/pages/project/chat/types';

/** How an ending reads: a fault, a ceiling, or neither. */
type Tone = 'neutral' | 'error' | 'warning';

/** The mark each tone carries, and the colour it and the words both take. */
const TONES = {
  error: { Icon: CircleAlert, colour: 'text-status-error-foreground' },
  warning: { Icon: TriangleAlert, colour: 'text-status-warning-foreground' },
  neutral: { Icon: Info, colour: 'text-muted-foreground' },
} as const;

/**
 * One ending line: a mark and a sentence, on the surface the reply sits on.
 *
 * Nothing is drawn around it. A bordered, filled bar reads as a thing of its
 * own sitting under the reply, and what this is is a note about the reply --
 * the colour of the mark and of the words is what says how to take it.
 *
 * The mark is centred against the line rather than against the block: the two
 * are the same while there is one line, and stop being the same the moment a
 * translation takes two.
 * @param root0 - What to draw.
 * @param root0.testId - What the test looks it up by.
 * @param root0.text - The line itself.
 * @param root0.tone - How it reads.
 * @param root0.alert - Announce it, for a failure happening right now.
 * @returns The line.
 */
function EndingLine({
  testId,
  text,
  tone,
  alert,
}: {
  testId: string;
  text: string;
  tone: Tone;
  alert?: boolean;
}): React.JSX.Element {
  const { Icon, colour } = TONES[tone];
  return (
    <div
      data-testid={testId}
      {...(alert === true ? { role: 'alert' } : {})}
      className={cn('mt-[0.85em] flex items-center gap-1.5 text-xs', colour)}
    >
      <Icon className='size-3.5 shrink-0' aria-hidden='true' />
      <span>{text}</span>
    </div>
  );
}

interface TurnEndingProps {
  /** The message this ending belongs to. */
  message: ChatMessage;
}

/**
 * A line saying how a turn ended.
 *
 * It says what happened and stops there. Asking for another answer is typing
 * another message, which the composer below is already for, and this panel is
 * built around that one move.
 *
 * A reply with nothing in it is told apart from a turn waiting on an answer
 * by the mark the server writes, never by reading the tool names -- which
 * tools stop a turn is a list in a package this one may not import.
 * @param root0 - The component props.
 * @param root0.message - The message this ending belongs to.
 * @returns The line, or nothing for a turn that ended with an answer.
 */
export function TurnEnding({ message }: TurnEndingProps): React.JSX.Element | null {
  const t = useTranslation();

  // Nothing is said about how a turn ended while it is still going.
  if (message.streaming === true) return null;

  if (message.failed === true) {
    return (
      <EndingLine
        testId='message-bubble-error'
        text={t('chat.error.turnFailed')}
        tone='error'
        {...(message.failedJustNow === true ? { alert: true } : {})}
      />
    );
  }

  if (message.truncated === true) {
    return (
      <EndingLine
        testId='message-bubble-truncated'
        text={t('chat.message.truncated')}
        tone='warning'
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

  // 「什么都没产出」，不是「没有正文」：一轮搜完图、没写正文，屏幕上是一排
  // 缩略图，底下再说一句「没有输出内容」就跟眼前的东西对着干。
  const producedSomething =
    message.assets !== undefined || message.sources !== undefined || message.toolCalls !== undefined;
  if (message.content === '' && !producedSomething && message.role === 'assistant') {
    return (
      <EndingLine testId='message-bubble-empty' text={t('chat.message.empty')} tone='neutral' />
    );
  }

  return null;
}
