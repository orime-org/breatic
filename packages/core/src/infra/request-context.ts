/**
 * Request-scoped context using AsyncLocalStorage.
 *
 * Stores user identity, conversation info, memory context, and compressed
 * conversation history. Set once per request at the route layer, then
 * accessible anywhere in the async call chain — including SubAgents.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MemoryContext, MessageData } from "@breatic/shared";

/** Shape of the per-request context store. */
export interface RequestStore {
  /** Current user ID. */
  userId: string;
  /** Current conversation ID. */
  conversationId: string;
  /** Associated project ID (may be undefined). */
  projectId?: string;
  /** Three-layer memory context (loaded once, shared by MainAgent + SubAgents). */
  memoryContext: MemoryContext;
  /** Compressed conversation history (old turns compressed, recent full). */
  compressedHistory: readonly MessageData[];
  /**
   * Billing state for the current turn. Set by MainAgent after saving the
   * user message (so we have a stable `turnIndex`), consumed by
   * `deductOnce` call sites for idempotent billing refKeys.
   *
   * - `turnIndex` — the conversation turn this request is processing,
   *   used to build `turn:${conversationId}:${turnIndex}` for main-agent
   *   billing and `spawn:${conversationId}:${turnIndex}:${idx}` for spawns.
   * - `spawnCount` — mutable counter, incremented by `spawnTool.execute`
   *   on each invocation. Each spawn in one turn gets a distinct refKey.
   *
   * Optional because not every code path uses AsyncLocalStorage (tests,
   * background jobs). Callers that need it must null-check.
   */
  billing?: {
    turnIndex: number;
    spawnCount: { value: number };
  };
}

/** The AsyncLocalStorage instance shared across the application. */
const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Run a callback within a request-scoped context.
 *
 * Typically called in the route handler to establish context for
 * the entire request processing chain.
 *
 * @param store - Request context data
 * @param fn - Async callback to run within the context
 * @returns The callback's return value
 *
 * @example
 * ```ts
 * runWithContext({ userId, conversationId, memoryContext, compressedHistory }, async () => {
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
 *
 * @returns The RequestStore for the current async context
 * @throws Error if called outside of a request context
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
 */
export function tryGetContext(): RequestStore | undefined {
  return storage.getStore();
}
