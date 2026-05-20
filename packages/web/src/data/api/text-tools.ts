import { sseStream } from '@/data/stream/sse';

export interface TextStreamEvent {
  type: 'token' | 'done' | 'error';
  payload: string;
}

interface TextToolRequest {
  toolId: string;
  document: string;
  selection?: { start: number; end: number };
}

export const textToolsApi = {
  /**
   * Stream a text mini-tool response (polish / expand / translate / etc).
   * Caller controls cancellation via `signal`.
   */
  stream(
    body: TextToolRequest,
    handlers: {
      onEvent: (e: TextStreamEvent) => void;
      onClose?: () => void;
      onError?: (err: unknown) => void;
      signal?: AbortSignal;
    },
  ) {
    return sseStream<TextStreamEvent>({
      url: '/mini-tools/text',
      body,
      parseEvent: (data) => {
        try {
          return JSON.parse(data) as TextStreamEvent;
        } catch {
          return { type: 'token', payload: data };
        }
      },
      ...handlers,
    });
  },
};
