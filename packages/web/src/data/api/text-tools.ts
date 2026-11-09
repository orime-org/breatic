// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The text mini-tool client (inner#1860): the document's AI commands ask
 * `POST /mini-tools/text` for a result and read it back as a stream.
 *
 * Each run is its own and charged on its own (design §5.1), so no
 * `Idempotency-Key` travels with it: a stream cannot be replayed, and a retry
 * is a new run.
 */

import type { TextToolLanguage, TextToolTone } from '@breatic/shared';

import { apiGet } from '@web/data/api/request';
import { sseStream } from '@web/data/stream/sse';

/** What every document command sends: its project, the selection and the context around it. */
interface OnSelection {
  readonly project_id: string;
  /** The selection, as Markdown. */
  readonly selection: string;
  /** The context the selection sits in, as Markdown. */
  readonly document: string;
}

/** A request the server's contract reads, one shape per tool. */
export type TextToolRequest =
  | (OnSelection & { readonly tool: 'polish' | 'expand' | 'shorten' | 'storyboard' })
  | (OnSelection & { readonly tool: 'translate'; readonly language: TextToolLanguage })
  | (OnSelection & { readonly tool: 'rewrite'; readonly style: TextToolTone })
  | (OnSelection & { readonly tool: 'custom'; readonly instructions: string });

/** One frame of the stream, as the caller hears it. */
export type TextStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string };

/** The budgets the browser windows a request to, and the pace it shows the answer at. */
export interface TextToolsConfig {
  readonly selectionMaxChars: number;
  readonly contextMaxChars: number;
  /** How fast the dialog shows the answer, in characters per second. */
  readonly revealCharsPerSecond: number;
}

/** The stream's lifecycle callbacks. */
interface StreamHandlers {
  /** Each frame, parsed. */
  onEvent: (event: TextStreamEvent) => void;
  /** A refusal, a drop, or a stream that closed with no end event. */
  onError?: (err: unknown) => void;
  /** Aborts the request, and the model call behind it. */
  signal?: AbortSignal;
}

/**
 * Reads one frame.
 * @param data - Its `data:` payload, JSON.
 * @param event - Its event name.
 * @returns The event, or null for a frame this client does not know.
 */
function parseFrame(data: string, event: string): TextStreamEvent | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event === 'text_delta') return typeof payload['text'] === 'string' ? { type: 'text_delta', text: payload['text'] } : null;
  if (event === 'done') return { type: 'done' };
  if (event === 'error') return { type: 'error', message: typeof payload['message'] === 'string' ? payload['message'] : '' };
  return null;
}

export const textToolsApi = {
  /**
   * Streams a text tool's result.
   * @param body - The request, as the server's contract reads it.
   * @param handlers - The stream's callbacks and abort signal.
   * @returns When the stream closes, fails or is aborted.
   */
  stream(body: TextToolRequest, handlers: StreamHandlers): Promise<void> {
    const { onEvent, onError, signal } = handlers;
    let ended = false;
    return sseStream<TextStreamEvent>({
      url: '/mini-tools/text',
      body,
      parseEvent: parseFrame,
      onEvent: (event) => {
        if (event.type !== 'text_delta') ended = true;
        onEvent(event);
      },
      // A stream that closes with neither `done` nor `error` did not finish,
      // whatever the transport says (design §6.2, E14).
      onClose: () => {
        if (!ended && signal?.aborted !== true) onError?.(new Error('the text tool stream closed before it ended'));
      },
      onError,
      signal,
    });
  },

  /**
   * The budgets from `GET /mini-tools/text/config`.
   * @returns The longest selection and context a request may carry, and the reveal speed.
   */
  config(): Promise<TextToolsConfig> {
    return apiGet<TextToolsConfig>('/mini-tools/text/config');
  },
};
