// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Chat panel message model — mirrored from the Agent message contract.
 * Lives next to the panel components so the UI layer has a stable type
 * regardless of the backend wire schema (data/api/chat.ts adapts).
 */

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  /** How far this use of the tool got, as the store recorded it. */
  status: 'pending' | 'success' | 'error';
  errorMessage?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Final-form content (HTML-sanitized server-side; safe to render). */
  content: string;
  /** Optional hidden chain-of-thought, foldable in the UI. */
  thinking?: string;
  toolCalls?: ToolCall[];
  /** Streaming = the bubble is still receiving tokens. */
  streaming?: boolean;
  /** The turn was stopped before it finished, so this is as far as it got. */
  interrupted?: true;
  /**
   * The turn failed and this reply is as much of it as there is.
   *
   * Stored, like {@link ChatMessage.interrupted}: the server records failure
   * as a part of the reply, so what is on screen while it happens and what a
   * reload brings back say the same thing.
   *
   * Only ever `true`; its absence is the ordinary case.
   */
  failed?: true;
  /**
   * The failure happened just now, with the reader waiting on this reply.
   *
   * It is the difference between living through a failure and reading about
   * one, and only the first is worth announcing — a reply that stops growing
   * and a stop button turning back into send are both purely visual, so
   * without this a screen reader user waits for an answer that is never
   * coming.
   *
   * Unlike {@link ChatMessage.failed} this is kept nowhere the message goes.
   * It belongs to the panel that watched it happen and is gone the moment
   * that panel is: not in the cache, which outlives the column being
   * collapsed, and not on the server, which would hand it back on reload.
   * Either would have a failure from ten minutes ago still announcing itself
   * as news.
   *
   * Only ever `true`; its absence is the ordinary case.
   */
  failedJustNow?: true;
}
