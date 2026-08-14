// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Interaction tool sentinel parsing (spec §10.18.4 v13).
 *
 * The three v13 interaction tools (`ask_user_choice`,
 * `propose_canvas_action`, `show_search_results`) return a
 * sentinel-prefixed JSON string from `execute()`. main-agent intercepts
 * the matching sentinel inside the `tool-result` part of the stream,
 * yields the right SSE event so the frontend can render a UI widget,
 * and stores the payload on the tool part of the reply it belongs to, so a
 * page reload can rebuild the same widget from history.
 *
 * Keeping sentinel decode out of `main-agent.ts` lets us unit-test the
 * parse logic in isolation without mocking the AI SDK stream.
 */
import {
  ASK_USER_SENTINEL,
  ASK_USER_CHOICE_SENTINEL,
  PROPOSE_CANVAS_ACTION_SENTINEL,
  SHOW_SEARCH_RESULTS_SENTINEL,
} from "@breatic/domain";

import { SSEEventType } from "@server/agent/types.js";

export type InteractionEvent =
  | typeof SSEEventType.AGENT_CHOICE
  | typeof SSEEventType.AGENT_CANVAS_ACTION
  | typeof SSEEventType.AGENT_SEARCH_RESULTS;

/**
 * The three tools, split by whether the turn can carry on without an answer.
 *
 * `ask_user_choice` asks a question the model needs answered, so the turn
 * stops there and waits. The other two only put something on screen — a set
 * of results, a proposed canvas edit — and the model is meant to keep writing
 * around them, and may raise several in one turn. Treating those as blocking
 * makes the first card a turn draws the last thing it says.
 */
const INTERACTION_TOOL_SENTINELS: ReadonlyArray<{
  sentinel: string;
  event: InteractionEvent;
  blocking: boolean;
}> = [
  { sentinel: ASK_USER_CHOICE_SENTINEL, event: SSEEventType.AGENT_CHOICE, blocking: true },
  { sentinel: PROPOSE_CANVAS_ACTION_SENTINEL, event: SSEEventType.AGENT_CANVAS_ACTION, blocking: false },
  { sentinel: SHOW_SEARCH_RESULTS_SENTINEL, event: SSEEventType.AGENT_SEARCH_RESULTS, blocking: false },
];

export interface ParsedInteraction {
  event: InteractionEvent;
  payload: Record<string, unknown>;
  /** Whether the turn has to stop here and wait for the user. */
  blocking: boolean;
}

/**
 * Detect + parse an interaction-tool sentinel.
 * @param resultStr - The raw `execute()` output of a tool, potentially prefixed with one of the v13 interaction sentinels.
 * @returns The matching SSE event, its parsed JSON payload, and whether the
 * turn must stop for it, when `resultStr` starts with one of the three v13
 * interaction sentinels. `null` for any non-interaction tool output
 * (including `ASK_USER_SENTINEL`, which the agent loop handles separately).
 *
 * On malformed JSON after a matched sentinel, returns the matched
 * event with `{ raw: resultStr }` so the frontend can still display
 * the agent's intent.
 */
export function parseInteractionSentinel(resultStr: string): ParsedInteraction | null {
  for (const { sentinel, event, blocking } of INTERACTION_TOOL_SENTINELS) {
    if (resultStr.startsWith(sentinel)) {
      try {
        const payload = JSON.parse(resultStr.slice(sentinel.length)) as Record<string, unknown>;
        return { event, payload, blocking };
      } catch {
        return { event, payload: { raw: resultStr }, blocking };
      }
    }
  }
  return null;
}

/**
 * Every marker a tool can prefix its result with.
 *
 * The three above plus the one `ask_user_question` uses, which the turn loop
 * reads directly rather than through {@link parseInteractionSentinel}. This
 * list is what makes "strip whatever marker is there" a single answer instead
 * of one answer per caller.
 */
const ALL_SENTINELS: readonly string[] = [
  ASK_USER_SENTINEL,
  ...INTERACTION_TOOL_SENTINELS.map((s) => s.sentinel),
];

/**
 * Take the marker off a tool result.
 *
 * A marker says which event the turn should raise; that question is answered
 * the moment it is read, and nothing downstream — not the model, not the
 * browser — has any use for it. So what gets stored and what gets sent on is
 * what the tool actually returned.
 * @param resultStr - The raw `execute()` output of a tool.
 * @returns The same string with its leading marker removed, or unchanged when
 * it carries none.
 */
export function stripSentinel(resultStr: string): string {
  for (const sentinel of ALL_SENTINELS) {
    if (resultStr.startsWith(sentinel)) return resultStr.slice(sentinel.length);
  }
  return resultStr;
}
