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
  /** Pending when the worker / SubAgent hasn't returned yet. */
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
}
