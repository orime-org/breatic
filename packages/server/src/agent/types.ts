/**
 * SSE event types for agent chat communication.
 *
 * These types define the wire format for Server-Sent Events
 * flowing from the backend to the frontend. Task lifecycle
 * events are delivered via Yjs document sync through the
 * Hocuspocus collab server.
 */

/** SSE event type enum. */
export const SSEEventType = {
  // Chat / Main Agent
  CHAT_CHUNK: "chat_chunk",
  CHAT_DONE: "chat_done",
  CHAT_PLAN: "chat_plan",

  // Agent progress
  AGENT_TOOL_HINT: "agent_tool_hint",
  AGENT_THINKING: "agent_thinking",
  AGENT_ASK: "agent_ask",

  // System
  ERROR: "error",
} as const;

export type SSEEventType = (typeof SSEEventType)[keyof typeof SSEEventType];

/** A single Server-Sent Event payload. */
export interface SSEEvent {
  event: SSEEventType;
  taskId?: string;
  data: Record<string, unknown>;
}

/**
 * Serialize an SSE event to wire format.
 *
 * @param event - The SSE event to serialize
 * @returns Formatted SSE string: `event: ...\ndata: ...\n\n`
 */
export function serializeSSE(event: SSEEvent): string {
  const data = JSON.stringify({
    event: event.event,
    task_id: event.taskId,
    data: event.data,
  });
  return `event: ${event.event}\ndata: ${data}\n\n`;
}
