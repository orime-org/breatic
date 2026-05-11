/**
 * History → live stream message adapter.
 *
 * `ChatPanel` calls `backendToLocal` on each row returned by
 * `GET /chat/conversations/:id` so prior turns rebuild as
 * `ChatStreamMessage`s. The non-trivial case is the v13 interaction
 * tools (`ask_user_choice` / `show_search_results` /
 * `propose_canvas_action`): main-agent persists their parsed payload
 * onto `tool_calls[0].result`, and we restore that into the
 * `toolCall` field so the F13 renderer rebuilds the rich UI without
 * having to re-parse sentinel-prefixed strings on the client.
 */
import { nanoid } from 'nanoid';

import type { MessageData } from '@breatic/shared';

import type { AgentToolCall, AgentToolName } from './agent-tool-types';
import type { ChatStreamMessage } from '@/features/chat/use-chat-stream';

const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set<AgentToolName>([
  'ask_user_choice',
  'show_search_results',
  'propose_canvas_action',
]);

/**
 * Convert a persisted `MessageData` row into a `ChatStreamMessage` for
 * the chat panel.
 *
 * Returns `null` when the row is not user-visible:
 *   - `role: 'tool'` — internal LLM-facing tool result.
 *   - assistant tool-call placeholder for a non-interaction tool
 *     (`read_file`, `web_search`, …) — LLM book-keeping only.
 *
 * Returns a `ChatStreamMessage` with `toolCall` filled when the row
 * represents an interaction tool with a parsed `result`.
 *
 * @param msg - The persisted message row.
 * @returns A live-stream message shape, or `null` to skip the row.
 */
export function backendToLocal(msg: MessageData): ChatStreamMessage | null {
  if (msg.role !== 'user' && msg.role !== 'assistant') return null;

  if (msg.role === 'assistant' && msg.tool_calls?.length) {
    const tc = msg.tool_calls[0];
    if (AGENT_TOOL_NAMES.has(tc.name) && tc.result) {
      return {
        id: nanoid(),
        role: 'assistant',
        content: msg.content,
        toolCall: { name: tc.name, args: tc.result } as unknown as AgentToolCall,
      };
    }
    return null;
  }

  return {
    id: nanoid(),
    role: msg.role,
    content: msg.content,
  };
}
