import { sseStream } from '@web/data/stream/sse';
import type { ChatMessage } from '@web/pages/project/chat/types';
import { apiGet } from '@web/data/api/request';

export interface ConversationSummary {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationDetail {
  id: string;
  name: string;
  messages: ChatMessage[];
}

export interface ChatStreamEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'thinking' | 'done' | 'error';
  payload: unknown;
}

export const chatApi = {
  listConversations(projectId: string) {
    return apiGet<{ conversations: ConversationSummary[] }>(
      '/chat/conversations',
      { params: { projectId } },
    );
  },
  getConversation(id: string) {
    return apiGet<ConversationDetail>(`/chat/conversations/${id}`);
  },
  /**
   * Stream a new agent message. Returns a promise that resolves when the
   * stream closes; events are pushed via `onEvent` as they arrive.
   *
   * Use an `AbortController` (`signal`) to let the user click Abort.
   * @param body - The message request payload.
   * @param body.projectId - Project the conversation belongs to.
   * @param body.conversationId - Existing conversation to append to; omitted to start a new one.
   * @param body.content - The user's message text.
   * @param body.references - Canvas entities (nodes / spaces) attached as context.
   * @param handlers - Stream lifecycle callbacks.
   * @param handlers.onEvent - Invoked for each parsed agent stream event.
   * @param handlers.onClose - Invoked when the stream closes cleanly.
   * @param handlers.onError - Invoked on transport / parse / abort error.
   * @param handlers.signal - Abort signal to cancel the stream on user request.
   * @returns A promise that resolves when the SSE stream closes.
   */
  streamMessage(
    body: {
      projectId: string;
      conversationId?: string;
      content: string;
      references?: Array<{ kind: string; id: string }>;
    },
    handlers: {
      onEvent: (e: ChatStreamEvent) => void;
      onClose?: () => void;
      onError?: (err: unknown) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    return sseStream<ChatStreamEvent>({
      url: '/chat/message',
      body,
      parseEvent: (data) => {
        try {
          return JSON.parse(data) as ChatStreamEvent;
        } catch {
          return null;
        }
      },
      ...handlers,
    });
  },
};
