/**
 * `parseInteractionSentinel` unit tests.
 *
 * Covers the three v13 interaction-tool sentinels, malformed-JSON
 * fallback, the unrelated `__ASK_USER__` sentinel (must return null),
 * and arbitrary tool output (must return null).
 */

import { describe, it, expect } from "vitest";

import { SSEEventType } from "../../agent/types.js";
import {
  parseInteractionSentinel,
  ASK_USER_SENTINEL,
  ASK_USER_CHOICE_SENTINEL,
  PROPOSE_CANVAS_ACTION_SENTINEL,
  SHOW_SEARCH_RESULTS_SENTINEL,
} from "../../agent/interaction-sentinel.js";

describe("parseInteractionSentinel", () => {
  it("parses ask_user_choice payload", () => {
    const payload = { question: "Pick one", choices: [{ id: "a", label: "A" }] };
    const result = parseInteractionSentinel(
      `${ASK_USER_CHOICE_SENTINEL}${JSON.stringify(payload)}`,
    );
    expect(result).toEqual({ event: SSEEventType.AGENT_CHOICE, payload });
  });

  it("parses propose_canvas_action payload", () => {
    const payload = {
      action: "create_nodes",
      rationale: "user asked for image",
      nodes: [{ type: "image", label: "ref" }],
    };
    const result = parseInteractionSentinel(
      `${PROPOSE_CANVAS_ACTION_SENTINEL}${JSON.stringify(payload)}`,
    );
    expect(result).toEqual({ event: SSEEventType.AGENT_CANVAS_ACTION, payload });
  });

  it("parses show_search_results payload", () => {
    const payload = { images: [{ url: "u1", title: "t1", source: "s1" }] };
    const result = parseInteractionSentinel(
      `${SHOW_SEARCH_RESULTS_SENTINEL}${JSON.stringify(payload)}`,
    );
    expect(result).toEqual({ event: SSEEventType.AGENT_SEARCH_RESULTS, payload });
  });

  it("returns raw fallback when JSON malformed after a matched sentinel", () => {
    const raw = `${ASK_USER_CHOICE_SENTINEL}{bad json`;
    const result = parseInteractionSentinel(raw);
    expect(result).toEqual({
      event: SSEEventType.AGENT_CHOICE,
      payload: { raw },
    });
  });

  it("returns null for the unrelated __ASK_USER__ sentinel", () => {
    expect(parseInteractionSentinel(`${ASK_USER_SENTINEL}{"question":"x"}`)).toBeNull();
  });

  it("returns null for arbitrary tool output", () => {
    expect(parseInteractionSentinel('{"data": "ok"}')).toBeNull();
    expect(parseInteractionSentinel("plain string")).toBeNull();
    expect(parseInteractionSentinel("")).toBeNull();
  });
});
