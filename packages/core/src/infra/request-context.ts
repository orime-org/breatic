// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Request-scoped context using AsyncLocalStorage.
 *
 * Stores user identity, conversation info, memory context, and compressed
 * conversation history. Set once per request at the route layer, then
 * accessible anywhere in the async call chain.
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Shape of the per-request context store. */
export interface RequestStore {
  /** Current user ID. */
  userId: string;
  /** Current conversation ID. */
  conversationId: string;
  /**
   * The project the conversation belongs to.
   *
   * Required, because every entrance confirms it before it starts a turn --
   * chat is refused outright for a project that is not the caller's. Left
   * optional, the one thing downstream of it has to invent a value for the
   * case that cannot happen, and what it invented was the empty string: not a
   * project id, and no longer obviously wrong to anything reading it.
   */
  projectId: string;
}

/** The AsyncLocalStorage instance shared across the application. */
const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Run a callback within a request-scoped context.
 *
 * Typically called in the route handler to establish context for
 * the entire request processing chain.
 * @param store - Request context data
 * @param fn - Async callback to run within the context
 * @returns The callback's return value
 * @example
 * ```ts
 * runWithContext({ userId, conversationId, projectId }, async () => {
 *   const agent = new MainAgent();
 *   yield* agent.chat(message);
 * });
 * ```
 */
export function runWithContext<T>(store: RequestStore, fn: () => T): T {
  return storage.run(store, fn);
}

/**
 * Get the current request context.
 * @returns The RequestStore for the current async context
 * @throws {Error} if called outside of a request context
 */
export function getContext(): RequestStore {
  const store = storage.getStore();
  if (!store) {
    throw new Error("getContext() called outside of request context. Ensure runWithContext() wraps the call chain.");
  }
  return store;
}

/**
 * Try to get the current request context, returning undefined if not in a context.
 *
 * Use this in code paths that may run both inside and outside a request
 * (e.g., background consolidation tasks).
 * @returns the current RequestStore, or `undefined` when outside any request context
 */
export function tryGetContext(): RequestStore | undefined {
  return storage.getStore();
}
