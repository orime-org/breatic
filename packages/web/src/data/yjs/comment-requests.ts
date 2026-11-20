// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment requests on a Space document's own connection (#1488 §11.9). Each
 * leaves after the provider's send window, so the edit it follows reaches
 * collab first on the same connection, and collab answers on it. A mention
 * collab has not confirmed is sent again once the connection is back and
 * synced; collab records a mention once, so sending it twice is harmless.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';

import {
  canvasSpaceDocName,
  CommentResponseSchema,
  documentSpaceDocName,
  newId,
  type CommentRequest,
  type CommentResponse,
} from '@breatic/shared';
import { readDocProvider } from '@web/data/yjs/collab-socket';

/** A request before it is given its id. */
export type CommentRequestBody = CommentRequest extends infer R ? (R extends CommentRequest ? Omit<R, 'id'> : never) : never;

/** The provider parts a request uses. */
type RequestProvider = Pick<HocuspocusProvider, 'sendStateless' | 'on' | 'off' | 'configuration'>;

/** How long a mention collab could not take yet waits before it is sent again. */
const MENTION_RETRY_MS = 2_000;

/**
 * Send one comment request and wait for collab's answer.
 * @param provider - The Space document's provider.
 * @param body - The request.
 * @returns Collab's answer, a refusal included.
 * @throws {Error} When the connection closes before the answer.
 */
export function sendCommentRequest(provider: RequestProvider, body: CommentRequestBody): Promise<CommentResponse> {
  const request = { ...body, id: newId() } as CommentRequest;
  return new Promise<CommentResponse>((resolve, reject) => {
    /**
     * Take collab's answer to this request.
     * @param data - A stateless message.
     * @param data.payload - Its text.
     */
    const onStateless = (data: { payload: string }): void => {
      let value: unknown;
      try {
        value = JSON.parse(data.payload);
      } catch {
        return;
      }
      const answer = CommentResponseSchema.safeParse(value);
      if (!answer.success || answer.data.id !== request.id) return;
      stop();
      resolve(answer.data);
    };
    /** The connection closed before the answer. */
    const onClose = (): void => {
      stop();
      reject(new Error('The connection closed before collab answered'));
    };
    /** Stop listening. */
    const stop = (): void => {
      provider.off('stateless', onStateless);
      provider.off('close', onClose);
    };
    provider.on('stateless', onStateless);
    provider.on('close', onClose);
    // After the provider's own send window: its update timer of the same
    // delay was set first, so the edit leaves ahead of the request.
    setTimeout(() => {
      try {
        provider.sendStateless(JSON.stringify(request));
      } catch (err) {
        stop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, provider.configuration.flushDelay || 0);
  });
}

/** Sends `comment:mentioned` and keeps what collab has not confirmed. */
export interface MentionOutbox {
  /** Ask collab to record what one entry mentions now. */
  mentioned: (spaceId: string, entryId: string) => void;
  /** Stop listening and forget what waits. */
  dispose: () => void;
}

/**
 * The mention requests of one Space document's provider.
 * @param provider - The provider.
 * @param options - Tuning.
 * @param options.retryMs - How long a mention collab could not take yet waits before it is sent again.
 * @returns The outbox.
 */
export function createMentionOutbox(provider: RequestProvider, options: { retryMs?: number } = {}): MentionOutbox {
  const retryMs = options.retryMs ?? MENTION_RETRY_MS;
  /**
   * The entries waiting for collab's confirmation, by `spaceId:entryId`;
   * `sending` numbers the request on its way, null when none is.
   */
  const waiting = new Map<string, { spaceId: string; entryId: string; sending: number | null }>();
  let sent = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let active = true;

  /**
   * Send one waiting mention unless it is already on its way.
   * @param key - Its key.
   */
  const send = (key: string): void => {
    const entry = waiting.get(key);
    if (!active || entry === undefined || entry.sending !== null) return;
    sent += 1;
    const attempt = sent;
    entry.sending = attempt;
    sendCommentRequest(provider, { type: 'comment:mentioned', payload: { spaceId: entry.spaceId, entryId: entry.entryId } }).then(
      (answer) => {
        if (entry.sending !== attempt) return;
        entry.sending = null;
        if (answer.ok || (answer.error.code !== 'BUSY' && answer.error.code !== 'INTERNAL')) {
          waiting.delete(key);
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          send(key);
        }, retryMs);
        timers.add(timer);
      },
      () => {
        // The connection closed; `synced` sends it again.
        if (entry.sending === attempt) entry.sending = null;
      },
    );
  };

  /** A closed connection answers nothing it was sent: everything waiting goes again on `synced`. */
  const onClose = (): void => {
    for (const entry of waiting.values()) entry.sending = null;
  };
  provider.on('close', onClose);

  /** Send everything still waiting once the connection is back and synced. */
  const onSynced = (): void => {
    for (const key of waiting.keys()) send(key);
  };
  provider.on('synced', onSynced);

  return {
    mentioned: (spaceId, entryId): void => {
      const key = `${spaceId}:${entryId}`;
      if (!waiting.has(key)) waiting.set(key, { spaceId, entryId, sending: null });
      send(key);
    },
    dispose: (): void => {
      active = false;
      provider.off('synced', onSynced);
      provider.off('close', onClose);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      waiting.clear();
    },
  };
}

/** One outbox per provider, made on first use. */
const outboxes = new WeakMap<HocuspocusProvider, MentionOutbox>();

/**
 * The provider of a canvas or document Space, if it is open.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param kind - Its type.
 * @returns The provider, or null.
 */
function spaceProvider(projectId: string, spaceId: string, kind: 'canvas' | 'document'): HocuspocusProvider | null {
  return readDocProvider(kind === 'canvas' ? canvasSpaceDocName(projectId, spaceId) : documentSpaceDocName(projectId, spaceId));
}

/**
 * Ask collab to record what one entry mentions now, on its Space's connection.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param kind - Its type.
 * @param entryId - The annotation body, reply or document comment.
 */
export function notifyMentioned(projectId: string, spaceId: string, kind: 'canvas' | 'document', entryId: string): void {
  const provider = spaceProvider(projectId, spaceId, kind);
  if (provider === null) return;
  let outbox = outboxes.get(provider);
  if (outbox === undefined) {
    outbox = createMentionOutbox(provider);
    outboxes.set(provider, outbox);
  }
  outbox.mentioned(spaceId, entryId);
}

/**
 * Send a hand-over request on a Space's connection.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param kind - Its type.
 * @param body - The request.
 * @returns Collab's answer.
 * @throws {Error} When the Space is not open or the connection closes before the answer.
 */
export async function sendSpaceCommentRequest(
  projectId: string,
  spaceId: string,
  kind: 'canvas' | 'document',
  body: CommentRequestBody,
): Promise<CommentResponse> {
  const provider = spaceProvider(projectId, spaceId, kind);
  if (provider === null) throw new Error('This Space is not open');
  return sendCommentRequest(provider, body);
}
