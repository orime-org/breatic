import { sseStream } from '@/data/stream/sse';
import type { ChatMessage } from '@/pages/project/chat/types';
import { apiGet } from '@/data/api/request';

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
  ) {
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
