// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { z } from 'zod';

/** The stateless transport slice of an authenticated Hocuspocus provider. */
export interface RpcCapableProvider {
  sendStateless(payload: string): void;
  on(event: 'stateless', callback: (data: { payload: string }) => void): void;
  off(event: 'stateless', callback: (data: { payload: string }) => void): void;
}

/** A sent request whose outcome remains unknown after its reply deadline. */
export class SpaceRpcUnanswered extends Error {
  /**
   * Name the request that drew no answer.
   * @param message - The unanswered request's diagnostic context.
   */
  constructor(message: string) {
    super(message);
    this.name = 'SpaceRpcUnanswered';
  }
}

/** Deadline and lifetime owned by the caller of one correlated request. */
export interface CorrelatedRpcOptions { timeoutMs: number; signal?: AbortSignal }

/**
 * Match a stateless reply by both the caller's schema and correlation identity.
 * @param provider - The authenticated provider carrying this request.
 * @param request - The complete envelope, including its correlation identity.
 * @param request.id - The request identity.
 * @param request.type - The diagnostic request type.
 * @param responseSchema - The only accepted reply contract.
 * @param options - The caller's deadline and cancellation lifetime.
 * @returns The validated reply for this request.
 * @throws {SpaceRpcUnanswered} When the reply deadline elapses.
 * @throws {DOMException} When the caller aborts this wait.
 * @throws {Error} When the provider cannot send the request.
 */
export async function sendCorrelatedRpc<T extends { id: string }>(
  provider: RpcCapableProvider,
  request: { id: string; type: string },
  responseSchema: z.ZodType<T>,
  options: CorrelatedRpcOptions,
): Promise<T> {
  if (options.signal?.aborted) throw new DOMException('RPC wait aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Release this request's subscription and deadline. */
    const cleanup = (): void => {
      provider.off('stateless', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    /**
     * Accept only schema-valid messages addressed to this request.
     * @param data - The provider envelope.
     * @param data.payload - The serialized response.
     */
    const onMessage = (data: { payload: string }): void => {
      let value: unknown;
      try { value = JSON.parse(data.payload); } catch { return; }
      const parsed = responseSchema.safeParse(value);
      if (!parsed.success || parsed.data.id !== request.id) return;
      cleanup();
      resolve(parsed.data);
    };
    /** Stop waiting without cancelling the server's already submitted work. */
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('RPC wait aborted', 'AbortError'));
    };
    provider.on('stateless', onMessage);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new SpaceRpcUnanswered(`Space RPC timeout for type=${request.type} (id=${request.id}, ${options.timeoutMs}ms)`));
    }, options.timeoutMs);
    try {
      provider.sendStateless(JSON.stringify(request));
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
