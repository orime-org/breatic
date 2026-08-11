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
 * Sentinels are deliberately absent. Those live in `@breatic/domain` because
 * they belong to a different conversation: a tool glues one onto its return
 * value and the agent loop recognises it, so they are how the loop and its
 * tools talk. These names are how the server and the browser talk. What a
 * browser has to understand to render a turn is the event name, never the
 * prefix — the loop slices it off before the event goes out, and the result
 * also re-enters the model's own context on the next request, which is the
 * other reason its home is the package the tools live in.
 *
 * Not to be read as "a browser never sees those strings". Two paths hand one
 * over: the tool message is persisted with the prefix intact
 * (`main-agent.ts`) and the conversation history endpoint returns it
 * verbatim, so a client rendering history receives it; and when the JSON
 * after a sentinel fails to parse, the loop deliberately passes the raw
 * string on (`{ raw: … }`, or `{ question: … }` on the ask-user path) so the
 * frontend can still show what the agent meant — unreachable through today's
 * four tools, which all build their payload with `JSON.stringify`, but it is
 * what the loop is written to do. Whether history should carry the prefix is
 * a separate question from where the constants live.
 */

/**
 * Every event name the agent chat stream carries.
 *
 * Closed set, and closed on what actually runs: a name is here because the
 * server emits it today, not because someone means to emit it later.
 *
 * Every event on this stream is built by `MainAgent.sse()`, which takes an
 * `SSEEventName` — so an undeclared name does not compile, and that direction
 * needs no test. What the compiler settles is that path, not the socket: the
 * route holds a `StreamingApi` whose `write` takes any string, and the text
 * mini-tool's route builds its frames by hand that way. Nothing on the chat
 * stream does today, and that is a fact about how `routes/chat.ts` is written
 * rather than a guarantee the type system hands out.
 *
 * The other direction is kept true by not writing names down early. A
 * contract listing an event nothing sends tells the browser to wait for
 * something that never arrives, and no amount of annotation makes that
 * sentence true. `agent_thinking` was the live example while it was still
 * unbuilt; PR-3 batch 6 built it, so it joined the list in the same change
 * that started emitting it.
 */
export const SSE_EVENT_NAMES = {
  // Chat / Main Agent
  CHAT_CHUNK: "chat_chunk",
  CHAT_DONE: "chat_done",

  // Agent progress
  AGENT_TOOL_HINT: "agent_tool_hint",
  AGENT_ASK: "agent_ask",

  // The model's own working, while it works. Each piece names the block it
  // belongs to, so a turn that thinks twice does not read as one long thought.
  AGENT_THINKING: "agent_thinking",

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
