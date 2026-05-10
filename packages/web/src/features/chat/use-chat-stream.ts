/**
 * `useChatStream` — wires `chatApi.sendMessage` SSE events to React
 * state for the v13 ChatPanel.
 *
 * The hook owns the messages array + an in-flight indicator. Send
 * appends a user message + an empty assistant placeholder, then
 * pipes SSE events into the placeholder:
 *
 *   - `chat_chunk`  → append text delta to the assistant content
 *   - `chat_done`   → mark complete; capture the conversation_id
 *                     when the backend just minted one
 *   - `agent_choice` / `agent_canvas_action` / `agent_search_results`
 *                   → attach the matching `toolCall` to the
 *                     assistant message so `AgentToolMessage`
 *                     renders inline (F13)
 *   - `error`       → mark the assistant message failed; ChatPanel
 *                     surfaces the error text
 *
 * The hook does NOT own conversation lifecycle (load history,
 * switch sessions) — that's ChatPanel's job. This hook is purely
 * "given a conversation_id and a user message, drive the placeholder
 * to a final state".
 *
 * Aborting an in-flight send: `abort()` cancels the underlying
 * SSE fetch and finalizes the assistant message with whatever text
 * arrived so the user keeps the partial reply rather than seeing
 * it disappear.
 */
import { useCallback, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { sendMessage as sendChatMessage } from '@/data/api/chat';
import type {
  AgentToolCall,
  AgentToolArgsAskUserChoice,
  AgentToolArgsShowSearchResults,
  AgentToolArgsProposeCanvasAction,
} from '@/features/chat/components/agent-tool-types';
import type { ChatAttachedChip } from '@breatic/shared';

/**
 * Local message shape — superset of the backend `MessageData` that
 * carries the v13 `toolCall` field for inline interaction widgets.
 * Persisted-history reads should map backend `MessageData` into this
 * shape (without `toolCall`, since the backend doesn't store
 * interaction events today).
 */
export interface ChatStreamMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** True while the assistant is still streaming chunks. */
  pending?: boolean;
  /** Final SSE error text — surfaced under the bubble when set. */
  errorMessage?: string;
  /** F13 — inline rich-output widget attached to this message. */
  toolCall?: AgentToolCall;
}

/** SSE event names the hook understands. Must mirror `server/agent/types.ts` SSEEventType. */
const EVENT = {
  CHAT_CHUNK: 'chat_chunk',
  CHAT_DONE: 'chat_done',
  AGENT_CHOICE: 'agent_choice',
  AGENT_CANVAS_ACTION: 'agent_canvas_action',
  AGENT_SEARCH_RESULTS: 'agent_search_results',
  ERROR: 'error',
} as const;

interface SendArgs {
  message: string;
  attached_chips?: ChatAttachedChip[];
  conversation_id?: string;
  project_id?: string;
}

interface UseChatStreamResult {
  messages: ChatStreamMessage[];
  /** True between `send` start and SSE close. */
  streaming: boolean;
  /** Latest known conversation id — backend mints one on first send. */
  conversationId: string | undefined;
  /**
   * Replace the messages list (e.g. after loading conversation
   * history). Useful when the panel switches sessions or remounts.
   */
  setMessages: (next: ChatStreamMessage[]) => void;
  /** Replace the conversation id (e.g. after `getConversation`). */
  setConversationId: (id: string | undefined) => void;
  /** Send a user message + drive an assistant reply via SSE. */
  send: (args: SendArgs) => Promise<void>;
  /** Abort the in-flight send. Safe to call when nothing is streaming. */
  abort: () => void;
}

/** Parse an SSE `event.data` JSON payload; returns null on malformed input. */
function parseSSEData(raw: string): { event: string; data: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.event === 'string') {
      return { event: parsed.event, data: parsed.data ?? {} };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Extract the text delta carried by `chat_chunk` / `chat_done`. */
function extractText(data: Record<string, unknown>): string {
  const v = data['text'] ?? data['content'] ?? '';
  return typeof v === 'string' ? v : '';
}

/** Map an `agent_*` SSE event payload to a typed `AgentToolCall`. */
function eventToToolCall(eventName: string, data: Record<string, unknown>): AgentToolCall | null {
  switch (eventName) {
    case EVENT.AGENT_CHOICE:
      return {
        name: 'ask_user_choice',
        args: data as unknown as AgentToolArgsAskUserChoice,
      };
    case EVENT.AGENT_CANVAS_ACTION:
      return {
        name: 'propose_canvas_action',
        args: data as unknown as AgentToolArgsProposeCanvasAction,
      };
    case EVENT.AGENT_SEARCH_RESULTS:
      return {
        name: 'show_search_results',
        args: data as unknown as AgentToolArgsShowSearchResults,
      };
    default:
      return null;
  }
}

export function useChatStream(): UseChatStreamResult {
  const [messages, setMessagesState] = useState<ChatStreamMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationIdState] = useState<string | undefined>(undefined);
  // Refs hold the latest values so SSE callbacks (which close over
  // the hook's first render) read fresh state without depending on
  // useCallback identity churn.
  const conversationIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const setMessages = useCallback((next: ChatStreamMessage[]) => {
    setMessagesState(next);
  }, []);

  const setConversationId = useCallback((id: string | undefined) => {
    conversationIdRef.current = id;
    setConversationIdState(id);
  }, []);

  /** Patch one assistant message in place by id; no-op when not found. */
  const patchAssistant = useCallback(
    (assistantId: string, patch: Partial<ChatStreamMessage>) => {
      setMessagesState((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    async ({ message, attached_chips = [], conversation_id, project_id }: SendArgs) => {
      // Cancel any prior in-flight stream before starting a new one
      // — avoids two assistant placeholders racing for the same
      // bubble.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMsg: ChatStreamMessage = {
        id: nanoid(),
        role: 'user',
        content: message,
      };
      const assistantMsg: ChatStreamMessage = {
        id: nanoid(),
        role: 'assistant',
        content: '',
        pending: true,
      };
      const assistantId = assistantMsg.id;
      setMessagesState((prev) => [...prev, userMsg, assistantMsg]);
      setStreaming(true);

      const effectiveConvId = conversation_id ?? conversationIdRef.current;

      try {
        await sendChatMessage(
          {
            message,
            attached_chips,
            resource_list: [],
            ...(effectiveConvId ? { conversation_id: effectiveConvId } : {}),
            ...(project_id ? { project_id } : {}),
          },
          {
            signal: controller.signal,
            onmessage: (ev) => {
              const parsed = parseSSEData(ev.data);
              if (!parsed) return;
              const { event, data } = parsed;

              if (event === EVENT.CHAT_CHUNK) {
                const delta = extractText(data);
                if (!delta) return;
                setMessagesState((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: m.content + delta }
                      : m,
                  ),
                );
                return;
              }

              if (event === EVENT.CHAT_DONE) {
                const newConvId = data['conversation_id'];
                if (typeof newConvId === 'string' && newConvId) {
                  conversationIdRef.current = newConvId;
                  setConversationIdState(newConvId);
                }
                // Some backends ship the final text body via `chat_done`
                // instead of streaming chunks — pick it up if present.
                const finalText = extractText(data);
                patchAssistant(assistantId, {
                  pending: false,
                  ...(finalText ? { content: finalText } : {}),
                });
                return;
              }

              const toolCall = eventToToolCall(event, data);
              if (toolCall) {
                patchAssistant(assistantId, { toolCall });
                return;
              }

              if (event === EVENT.ERROR) {
                const errText = typeof data['message'] === 'string'
                  ? (data['message'] as string)
                  : 'Chat error';
                patchAssistant(assistantId, {
                  pending: false,
                  errorMessage: errText,
                });
              }
            },
            onerror: (err) => {
              // The fetchEventSource wrapper rethrows on error; let
              // the outer try/catch surface it as the assistant's
              // errorMessage so the user sees something happened.
              throw err;
            },
            onclose: () => {
              // SSE finished without a `chat_done` — finalize the
              // placeholder so the UI doesn't sit in `pending` forever.
              setMessagesState((prev) =>
                prev.map((m) =>
                  m.id === assistantId && m.pending
                    ? { ...m, pending: false }
                    : m,
                ),
              );
              setStreaming(false);
              if (abortRef.current === controller) {
                abortRef.current = null;
              }
            },
          },
        );
      } catch (err) {
        if (controller.signal.aborted) {
          // User-initiated abort — keep whatever text arrived,
          // just clear pending.
          patchAssistant(assistantId, { pending: false });
        } else {
          const errText = err instanceof Error ? err.message : String(err);
          patchAssistant(assistantId, { pending: false, errorMessage: errText });
        }
        setStreaming(false);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [patchAssistant],
  );

  return {
    messages,
    streaming,
    conversationId,
    setMessages,
    setConversationId,
    send,
    abort,
  };
}
