// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { isReaderLine } from '@breatic/shared';
import type { ChatMessage, ToolCall } from '@web/pages/project/chat/types';

/** The part type carrying a turn that was stopped. */
const INTERRUPTED = 'data-interrupted';

/** The part type carrying a turn that could not be finished. */
const FAILED = 'data-failed';

/**
 * How far a tool got, in the panel's words.
 * @param state - The tool part's state, as the SDK reports it.
 * @param stillRunning - Whether the turn that made this call is still going.
 * @returns Our word for the same thing.
 */
function statusOf(state: string, stillRunning: boolean): ToolCall['status'] {
  if (state === 'output-available') return 'success';
  if (state === 'output-error' || state === 'output-denied') return 'error';
  // Not finished, and nothing is coming: a turn stopped locally leaves its
  // calls exactly where they were -- the SDK does not push them to any end
  // state -- so a card left on `pending` here spins until the page is
  // reloaded. The server settles the same thing before it stores a turn
  // (`main-agent.ts`, "nothing in a stored record may still say it is
  // running"); this is that same reading, one moment earlier.
  return stillRunning ? 'pending' : 'error';
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

  // Read before the loop because a tool part can come before the mark. A call
  // this turn cut short has nothing on it saying so — the SDK client leaves it
  // exactly where it was — and this mark is the only answer to who stopped it.
  const wasStopped = message.parts.some((p) => p.type === INTERRUPTED);

  for (const part of message.parts) {
    if (isToolUIPart(part)) {
      const status = statusOf(part.state, options.streaming === true);
      // Cut short rather than failed: it never reached an end state of its
      // own, and the turn it belonged to was stopped.
      const cutShort =
        status === 'error' && wasStopped && part.state !== 'output-error'
          ? ({ failureKind: 'user_aborted' } as const)
          : {};
      toolCalls.push({
        id: part.toolCallId,
        name: getToolName(part),
        args: (part.input ?? {}) as ToolCall['args'],
        status,
        ...(status === 'success' ? { result: part.output as string } : {}),
        ...cutShort,
        // The key vouches for itself: it is either one of ours or it is not,
        // and the table is what answers that. The same field carries the SDK's
        // own fixed English sentence when it has nothing else to put there,
        // and taking that as our own put it on the screen untranslated, in a
        // product that ships five languages.
        ...(status === 'error' && 'errorText' in part && isReaderLine(part.errorText)
          ? { failureKey: part.errorText }
          : {}),
        // What the message itself says the ending was. A replayed one always
        // carries it; a live one never does -- the wire has a single field for
        // a failure and it is carrying the line. The live answer is the one
        // worked out above, and it is left alone here: this spread only fires
        // when the field is present, which on a live message it is not.
        ...(status === 'error' && 'failureKind' in part
          ? { failureKind: (part as { failureKind: ToolCall['failureKind'] }).failureKind }
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
