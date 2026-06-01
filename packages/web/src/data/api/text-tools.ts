import { sseStream } from '@web/data/stream/sse';

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
   * @param body - The tool request: tool id, document text, and optional selection range.
   * @param handlers - Stream lifecycle callbacks.
   * @param handlers.onEvent - Invoked for each parsed text stream event (token / done / error).
   * @param handlers.onClose - Invoked when the stream closes cleanly.
   * @param handlers.onError - Invoked on transport / parse / abort error.
   * @param handlers.signal - Abort signal to cancel the stream on user request.
   * @returns A promise that resolves when the SSE stream closes.
   */
  stream(
    body: TextToolRequest,
    handlers: {
      onEvent: (e: TextStreamEvent) => void;
      onClose?: () => void;
      onError?: (err: unknown) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
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
