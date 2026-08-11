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
   * Local only: the server has no such field, and no stored message carries
   * it. What failed is this attempt, not anything that was written down.
   */
  failed?: boolean;
}
