// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';

import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';
import { ThinkingFold } from '@web/pages/project/chat/ThinkingFold';
import { SourceRow } from '@web/pages/project/chat/SourceRow';
import { ToolRunLine } from '@web/pages/project/chat/ToolRunLine';
import { TurnActions } from '@web/pages/project/chat/TurnActions';
import { TurnEnding } from '@web/pages/project/chat/TurnEnding';
import { WaitingDot } from '@web/pages/project/chat/WaitingDot';
import type { ChatMessage } from '@web/pages/project/chat/types';

interface MessageBubbleProps {
  message: ChatMessage;
  /**
   * Whether this turn stopped to fold its memory before answering.
   *
   * A property of the turn rather than of the message: nothing about it is
   * stored, and it is true of the reply that has not started yet.
   */
  consolidating?: boolean;
  /** Run this turn again. Also what the retry on a failed turn calls. */
  onRetry?: (messageId: string) => void;
  /** Carry on from where a reply cut off at the ceiling stops. */
  onContinue?: (messageId: string) => void;
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
 * @param root0.consolidating - Whether this turn stopped to fold memory.
 * @returns The message bubble with optional thinking fold and tool-call cards.
 */
export const MessageBubble = React.memo(function MessageBubble({
  message,
  consolidating,
  onRetry,
  onContinue,
}: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === 'user';
  // The newest call still running, which is the one the line names. Several
  // can run at once -- nothing disables parallel tool calls -- and one line
  // for the turn is what was settled; a stack of them is a log.
  const runningCall = React.useMemo(
    () => message.toolCalls?.filter((c) => c.status === 'pending').at(-1),
    [message.toolCalls],
  );
  const running = message.streaming === true;
  return (
    <div
      data-testid='message-bubble'
      data-role={message.role}
      className={cn(
        'group flex w-full',
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
                {...(message.citations ? { citations: message.citations } : {})}
              />
            ) : null}
            {/* One mark for the whole turn, after everything said so far. It
                says the answer is still coming, which makes it this turn's
                state rather than part of the answer — so it goes after the
                rendering, and what the reply is made of never enters into it
                (user 2026-08-25). The space between the two is in the
                stylesheet, beside the mark's own figures. */}
            {running && runningCall === undefined ? (
              <WaitingDot consolidating={consolidating} />
            ) : null}
          </div>
        ) : null}
        {/* What the turn is doing, at the end of whatever it has said so far.
            It is gone the moment the turn ends and nothing about it is
            stored, so a reload shows the answer and no trace of how it was
            assembled (A5). */}
        {running && runningCall !== undefined ? <ToolRunLine call={runningCall} /> : null}
        {/* Where the answer came from. Content rather than process, so unlike
            the line above it stays once the turn has ended -- and it is drawn
            only then, because a row that grows as searches come back would
            move under the reader while they are still reading. */}
        {running || message.sources === undefined ? null : (
          <SourceRow sources={message.sources} />
        )}
        {/* How the turn ended goes last, after everything it produced: this
            is the line that says there is no more, so nothing may follow it.
            Each is a paragraph's distance from what it follows, which is what
            separates any two blocks in this scope. */}
        {isUser ? null : (
          <TurnEnding message={message} {...(onRetry ? { onRetry } : {})} {...(onContinue ? { onContinue } : {})} />
        )}
        {/* Offered on a settled message only. A reply still arriving has
            nothing to copy yet and asking for it again mid-flight would race
            the turn that is running. */}
        {running || message.content === '' ? null : (
          <TurnActions
            messageId={message.id}
            text={message.content}
            {...(isUser ? { onHoverOnly: true } : onRetry ? { onRetry } : {})}
          />
        )}
      </div>
    </div>
  );
});
