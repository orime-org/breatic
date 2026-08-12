// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import { ThinkingFold } from '@web/pages/project/chat/ThinkingFold';
import { ToolCallCard } from '@web/pages/project/chat/ToolCallCard';
import type { ChatMessage } from '@web/pages/project/chat/types';

interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Renders one message in the chat list. Layout flips left/right based on
 * role; thinking + tool calls nest inside the bubble so they share the
 * bubble's column.
 * @param root0 - The component props.
 * @param root0.message - The chat message to render.
 * @returns The message bubble with optional thinking fold and tool-call cards.
 */
export function MessageBubble({
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
          'max-w-[80%] rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground',
        )}
      >
        {message.thinking ? (
          <ThinkingFold thinking={message.thinking} />
        ) : null}
        {message.content || message.streaming ? (
          <div
            className='whitespace-pre-wrap'
            data-testid='message-bubble-content'
          >
            {message.content}
            {message.streaming ? (
              <span aria-label='streaming' className='ml-1 animate-pulse'>
                ▌
              </span>
            ) : null}
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
          // Stated, not announced. This is stored now and comes back with the
          // history, so an assertive region would read out every past failure
          // in the conversation the moment the panel opens. The mark for a
          // stopped turn, above, has always been plain text for that reason.
          <div
            data-testid='message-bubble-error'
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
}
