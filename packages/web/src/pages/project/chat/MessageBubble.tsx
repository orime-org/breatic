// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';
import { ThinkingFold } from '@web/pages/project/chat/ThinkingFold';
import { ToolCallCard } from '@web/pages/project/chat/ToolCallCard';
import { WaitingDot } from '@web/pages/project/chat/WaitingDot';
import type { ChatMessage } from '@web/pages/project/chat/types';

interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Renders one message in the chat list. Layout flips left/right based on
 * role; thinking + tool calls nest inside the bubble so they share the
 * bubble's column.
 *
 * Memoised, and the hook above keeps the object for a settled message the
 * same one from render to render — the two together are what stop a reply
 * arriving one token at a time from redrawing the whole conversation behind
 * it, several dozen bubbles at a time.
 * @param root0 - The component props.
 * @param root0.message - The chat message to render.
 * @returns The message bubble with optional thinking fold and tool-call cards.
 */
export const MessageBubble = React.memo(function MessageBubble({
  message,
}: MessageBubbleProps): React.JSX.Element {
  const t = useTranslation();
  const isUser = message.role === 'user';
  return (
    <div
      data-testid='message-bubble'
      data-role={message.role}
      className={cn(
        'flex w-full',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'text-sm',
          // Only what a person says gets a container. The agent is not one
          // side of a conversation -- it is the panel talking -- so its words
          // sit directly on the surface, with nothing drawn around them.
          //
          // The reader's own words keep theirs, held back from the far edge:
          // that gap is what makes a message read as one side of an exchange.
          // `bg-accent` because it has to lift off the surface in both
          // themes, and it is the only neutral fill that does -- `bg-muted`
          // is a recess and goes darker than the surface in dark mode.
          isUser
            ? 'max-w-[80%] rounded-lg bg-accent px-3 py-2 text-foreground'
            : 'w-full text-foreground',
        )}
      >
        {message.thinking ? (
          <ThinkingFold thinking={message.thinking} />
        ) : null}
        {message.content || message.streaming ? (
          <div data-testid='message-bubble-content'>
            {/* What the reader typed means the characters they typed: markdown
                is what the model writes in, not what the composer accepts. */}
            {isUser ? (
              <span className='whitespace-pre-wrap'>{message.content}</span>
            ) : null}
            {!isUser && message.content ? (
              <MarkdownMessage
                content={message.content}
                streaming={message.streaming === true}
              />
            ) : null}
            {/* One mark for the whole turn, after everything said so far. It
                says the answer is still coming, which makes it this turn's
                state rather than part of the answer — so it goes after the
                rendering, and what the reply is made of never enters into it
                (user 2026-08-25). The space between the two is in the
                stylesheet, beside the mark's own figures. */}
            {message.streaming ? <WaitingDot /> : null}
          </div>
        ) : null}
        {message.interrupted ? (
          // The backend stores this mark so a cut-off answer can be told apart
          // from a complete one; without drawing it the whole chain is wasted.
          <div
            data-testid='message-bubble-interrupted'
            className='text-xs text-muted-foreground'
          >
            {t('chat.message.interrupted')}
          </div>
        ) : null}
        {message.failed ? (
          // On the turn it belongs to rather than as a banner: what failed is
          // this reply, and a bar at the top of the panel would say the whole
          // conversation had. The wording is ours — what the server sends on
          // this path is a hardcoded English sentence.
          //
          // Announced only when it just happened. Someone waiting on an answer
          // has nothing else to go on: the reply stops growing and the stop
          // button turns back into send, both of which can only be seen. But
          // failure is also stored and comes back with the history, and an
          // assertive region on those would read out every past failure in
          // the conversation the moment the panel opens — so the mark that
          // separates the two is what decides whether this one speaks.
          <div
            data-testid='message-bubble-error'
            {...(message.failedJustNow ? { role: 'alert' } : {})}
            className='rounded-content-sm border border-status-error-border bg-status-error-bg px-2 py-1 text-xs text-status-error-foreground'
          >
            {t('chat.error.turnFailed')}
          </div>
        ) : null}
        {message.toolCalls?.map((tc) => (
          <ToolCallCard key={tc.id} toolCall={tc} />
        ))}
      </div>
    </div>
  );
});
