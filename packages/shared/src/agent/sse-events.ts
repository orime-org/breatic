// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the agent chat stream carries, said once for both sides of it.
 *
 * The backend and the browser each used to name these events themselves, and
 * the two lists had nothing in common but the word `error`: the server sent
 * `chat_chunk` / `chat_done` / `agent_*` in an `{ event, task_id, data }`
 * envelope, while the client declared `token` / `tool_call` / `done` in a
 * `{ type, payload }` one. Nothing caught it, because the client's version had
 * never run — its requests were going to an address the server does not serve.
 *
 * The shape here is the one that has been observed on the wire, not the one
 * that was written first. Anything else would be asking a working stream to
 * accommodate a spelling nothing has ever spoken.
 *
 * Sentinels are deliberately absent. Those live in `@breatic/domain`, because
 * they never reach a browser: a tool glues one onto its return value, the
 * agent loop recognises it and slices it back off, and what goes out is an
 * event name and a payload. The two protocols stay apart — sentinels are how
 * the loop and its tools talk, these names are how the server and the browser
 * talk.
 */

/**
 * Every event name the agent chat stream may carry.
 *
 * Closed set: an event the server can emit that is not here is a break in the
 * contract, and `packages/server/src/__tests__/agent/sse-contract.test.ts`
 * reads the emit sites to say so.
 */
export const SSE_EVENT_NAMES = {
  // Chat / Main Agent
  CHAT_CHUNK: "chat_chunk",
  CHAT_DONE: "chat_done",

  // Agent progress
  AGENT_TOOL_HINT: "agent_tool_hint",
  AGENT_THINKING: "agent_thinking",
  AGENT_ASK: "agent_ask",

  // Interaction tools — the model calls these "tools" not to run something
  // but to carry structured data, and the browser renders a widget per name.
  AGENT_CHOICE: "agent_choice",
  AGENT_CANVAS_ACTION: "agent_canvas_action",
  AGENT_SEARCH_RESULTS: "agent_search_results",

  // System
  ERROR: "error",
} as const;

export type SSEEventName = (typeof SSE_EVENT_NAMES)[keyof typeof SSE_EVENT_NAMES];

/**
 * Names the contract declares that nothing emits yet, each with the reason.
 *
 * Declaring an event before anything sends it is fine; leaving that fact
 * unsaid is not, because then "the contract lists nine, the server sends
 * eight" reads as a defect to whoever counts next. Every entry here is
 * checked both ways by the contract test: an unemitted name missing from this
 * list fails, and a name listed here that something does emit fails too, so
 * an entry cannot outlive its reason.
 */
export const SSE_EVENTS_DECLARED_NOT_EMITTED: Partial<Record<SSEEventName, string>> = {
  [SSE_EVENT_NAMES.AGENT_THINKING]:
    "The model's reasoning is collected during a turn but never streamed; PR-3 batch 6 decides how it reaches the screen.",
};

/**
 * One event as it appears on the wire.
 *
 * `task_id` is snake_case and optional because that is what the server
 * serialises today; whether it belongs here at all is a separate question
 * from describing it truthfully.
 */
export interface SSEEventEnvelope {
  event: SSEEventName;
  task_id?: string;
  data: Record<string, unknown>;
}
