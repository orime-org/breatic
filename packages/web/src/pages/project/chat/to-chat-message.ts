// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One message, from what the protocol carries to what the panel draws.
 *
 * The panel wants prose as one string, thinking as another, and tool calls as
 * a list; the protocol carries parts in the order they happened. Reading the
 * parts out is this function's whole job, and it happens here rather than in
 * the bubble because two of the three are joins across several parts —
 * something a component would have to redo on every render.
 *
 * The store used to send these three already flattened, alongside the parts
 * they came from. They are worked out here now: a second copy on the wire is
 * one the client has to keep in step with the first.
 */
import { getToolName, isToolUIPart } from 'ai';
import type { UIMessage } from 'ai';
import type { ChatMessage, ToolCall } from '@web/pages/project/chat/types';

/** The part type carrying a turn that was stopped. */
const INTERRUPTED = 'data-interrupted';

/** The part type carrying a turn that could not be finished. */
const FAILED = 'data-failed';

/**
 * How far a tool got, in the panel's words.
 * @param state - The tool part's state, as the SDK reports it.
 * @returns Our word for the same thing.
 */
function statusOf(state: string): ToolCall['status'] {
  if (state === 'output-available') return 'success';
  if (state === 'output-error' || state === 'output-denied') return 'error';
  return 'pending';
}

/**
 * Adapt one message into what the panel renders.
 * @param message - The message as the conversation holds it.
 * @param options - What is true of this message right now rather than of the
 *   message itself.
 * @param options.streaming - Its bubble is still receiving tokens.
 * @param options.failedJustNow - This failure is happening with the reader
 *   waiting on it, rather than being read back out of the history.
 * @returns The same message in the panel's shape.
 */
export function toChatMessage(
  message: UIMessage,
  options: { streaming?: boolean; failedJustNow?: boolean } = {},
): ChatMessage {
  let content = '';
  let thinking = '';
  const toolCalls: ToolCall[] = [];
  let interrupted = false;
  let failed = false;

  for (const part of message.parts) {
    if (isToolUIPart(part)) {
      const status = statusOf(part.state);
      toolCalls.push({
        id: part.toolCallId,
        name: getToolName(part),
        args: (part.input ?? {}) as Record<string, unknown>,
        status,
        ...(status === 'success' ? { result: part.output as string } : {}),
        ...(status === 'error' && 'errorText' in part && part.errorText !== undefined
          ? { errorMessage: part.errorText }
          : {}),
      });
      continue;
    }
    if (part.type === 'text') content += part.text;
    else if (part.type === 'reasoning') thinking += part.text;
    else if (part.type === INTERRUPTED) interrupted = true;
    else if (part.type === FAILED) failed = true;
  }

  return {
    id: message.id,
    // A stored role is only ever one of these two; the panel's third is for
    // messages it makes up itself, which none of these are.
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
    ...(thinking !== '' ? { thinking } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(interrupted ? { interrupted: true as const } : {}),
    ...(failed ? { failed: true } : {}),
    ...(options.failedJustNow === true ? { failedJustNow: true as const } : {}),
    ...(options.streaming === true ? { streaming: true } : {}),
  };
}
