/**
 * Interaction tool sentinel parsing (spec §10.18.4 v13).
 *
 * The three v13 interaction tools (`ask_user_choice`,
 * `propose_canvas_action`, `show_search_results`) return a
 * sentinel-prefixed JSON string from `execute()`. main-agent intercepts
 * the matching sentinel inside the `tool-result` part of the stream,
 * yields the right SSE event so the frontend can render a UI widget,
 * and persists the parsed payload onto `tool_calls[0].result` so a
 * page reload can rebuild the same widget from history.
 *
 * Keeping sentinel decode out of `main-agent.ts` lets us unit-test the
 * parse logic in isolation without mocking the AI SDK stream.
 */
import { SSEEventType } from "@server/agent/types.js";

export const ASK_USER_SENTINEL = "__ASK_USER__";
export const ASK_USER_CHOICE_SENTINEL = "__ASK_USER_CHOICE__";
export const PROPOSE_CANVAS_ACTION_SENTINEL = "__PROPOSE_CANVAS_ACTION__";
export const SHOW_SEARCH_RESULTS_SENTINEL = "__SHOW_SEARCH_RESULTS__";

export type InteractionEvent =
  | typeof SSEEventType.AGENT_CHOICE
  | typeof SSEEventType.AGENT_CANVAS_ACTION
  | typeof SSEEventType.AGENT_SEARCH_RESULTS;

const INTERACTION_TOOL_SENTINELS: ReadonlyArray<{
  sentinel: string;
  event: InteractionEvent;
}> = [
  { sentinel: ASK_USER_CHOICE_SENTINEL, event: SSEEventType.AGENT_CHOICE },
  { sentinel: PROPOSE_CANVAS_ACTION_SENTINEL, event: SSEEventType.AGENT_CANVAS_ACTION },
  { sentinel: SHOW_SEARCH_RESULTS_SENTINEL, event: SSEEventType.AGENT_SEARCH_RESULTS },
];

export interface ParsedInteraction {
  event: InteractionEvent;
  payload: Record<string, unknown>;
}

/**
 * Detect + parse an interaction-tool sentinel.
 * @param resultStr - The raw `execute()` output of a tool, potentially prefixed with one of the v13 interaction sentinels.
 * @returns The matching SSE event and parsed JSON payload when
 * `resultStr` starts with one of the three v13 interaction sentinels.
 * `null` for any non-interaction tool output (including `__ASK_USER__`
 * which is handled separately by the agent loop).
 *
 * On malformed JSON after a matched sentinel, returns the matched
 * event with `{ raw: resultStr }` so the frontend can still display
 * the agent's intent.
 */
export function parseInteractionSentinel(resultStr: string): ParsedInteraction | null {
  for (const { sentinel, event } of INTERACTION_TOOL_SENTINELS) {
    if (resultStr.startsWith(sentinel)) {
      try {
        const payload = JSON.parse(resultStr.slice(sentinel.length)) as Record<string, unknown>;
        return { event, payload };
      } catch {
        return { event, payload: { raw: resultStr } };
      }
    }
  }
  return null;
}
