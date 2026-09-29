// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which OpenRouter generation a stream has open (#296).
 *
 * A stream's model calls run one after another; the id of the one that
 * started and has not ended is what a stream cut off mid-call looks up later.
 */

/**
 * The generation id on one of OpenRouter's streamed chunks.
 * @param rawValue - The chunk as the provider parsed it.
 * @returns The id, or undefined when the value is not an OpenRouter chunk.
 */
export function generationIdOf(rawValue: unknown): string | undefined {
  if (typeof rawValue !== "object" || rawValue === null) return undefined;
  const id = (rawValue as { id?: unknown }).id;
  return typeof id === "string" && id.startsWith("gen-") ? id : undefined;
}

/** Which model call of a stream has started and not ended. */
export interface OpenGeneration {
  /** Hand it every raw chunk of the stream. */
  seen(rawValue: unknown): void;
  /**
   * Call when a model call ended. The id it ended with and the id held open
   * are both closed for good, so a raw chunk of the call that a slow reader
   * receives afterwards does not open it again.
   */
  ended(generationId: string): void;
  /** The generation still open, if any. */
  pending(): string | undefined;
}

/**
 * Track the one model call a stream has open. A stream runs its calls one
 * after another, so there is at most one.
 * @returns The tracker.
 */
export function trackOpenGeneration(): OpenGeneration {
  let open: string | undefined;
  const closed = new Set<string>();
  return {
    seen(rawValue) {
      const id = generationIdOf(rawValue);
      if (id !== undefined && !closed.has(id)) open = id;
    },
    ended(generationId) {
      closed.add(generationId);
      if (open !== undefined) closed.add(open);
      open = undefined;
    },
    pending() {
      return open;
    },
  };
}
