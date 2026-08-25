// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the conversation shows, given what the library holds.
 */
import type { ChatStatus, UIMessage } from 'ai';

/**
 * Drop the message the reader has sent but the server has not answered.
 *
 * Only in `submitted`, and only the last one. Earlier user messages end a
 * history for reasons of their own -- a turn that failed, one still being
 * answered -- and a rule that dropped every trailing user message would
 * erase those too. Once the first frame arrives the message belongs to the
 * conversation: its reply is arriving beside it and the box has been
 * emptied.
 * @param messages - Everything the chat holds, in order.
 * @param status - Where the request stands.
 * @returns The messages to render.
 */
export function visibleMessages<Message extends UIMessage<unknown>>(
  messages: readonly Message[],
  status: ChatStatus,
): readonly Message[] {
  if (status !== 'submitted') return messages;
  return messages.at(-1)?.role === 'user' ? messages.slice(0, -1) : messages;
}
