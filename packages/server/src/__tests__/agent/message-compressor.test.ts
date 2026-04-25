/**
 * Message compressor tests.
 */

import { describe, it, expect } from "vitest";
import type { MessageData } from "@breatic/shared";
import { groupByTurn, compressTurn, compressForContext } from "../../agent/message-compressor.js";

/** Helper to build a message. */
function msg(
  role: "user" | "assistant" | "tool",
  content: string,
  turnIndex: number,
  extras?: Partial<MessageData>,
): MessageData {
  return { role, content, ts: "2026-04-01T00:00:00Z", turnIndex, ...extras };
}

describe("groupByTurn", () => {
  it("should group messages by turnIndex", () => {
    const messages = [
      msg("user", "Hello", 1),
      msg("assistant", "", 1, { tool_calls: [{ id: "tc1", name: "search", arguments: {} }] }),
      msg("tool", '{"result": "found"}', 1, { tool_call_id: "tc1", name: "search" }),
      msg("assistant", "Here's what I found", 1),
      msg("user", "Thanks", 2),
      msg("assistant", "You're welcome", 2),
    ];

    const groups = groupByTurn(messages);
    expect(groups.size).toBe(2);
    expect(groups.get(1)).toHaveLength(4);
    expect(groups.get(2)).toHaveLength(2);
  });

  it("should return empty map for empty input", () => {
    expect(groupByTurn([]).size).toBe(0);
  });
});

describe("compressTurn", () => {
  it("should keep only user message + final assistant reply", () => {
    const turnMsgs = [
      msg("user", "Search for cyberpunk", 1),
      msg("assistant", "", 1, { tool_calls: [{ id: "tc1", name: "search", arguments: {} }] }),
      msg("tool", '{"urls": ["a.jpg"]}', 1, { tool_call_id: "tc1" }),
      msg("assistant", "", 1, { tool_calls: [{ id: "tc2", name: "analyze", arguments: {} }] }),
      msg("tool", '{"style": "neon"}', 1, { tool_call_id: "tc2" }),
      msg("assistant", "Found 3 cyberpunk reference images with neon style.", 1),
    ];

    const compressed = compressTurn(turnMsgs);
    expect(compressed).toHaveLength(2);
    expect(compressed[0]!.role).toBe("user");
    expect(compressed[0]!.content).toBe("Search for cyberpunk");
    expect(compressed[1]!.role).toBe("assistant");
    expect(compressed[1]!.content).toBe("Found 3 cyberpunk reference images with neon style.");
  });

  it("should strip thinking and tool_calls from kept messages", () => {
    const turnMsgs = [
      msg("user", "Hello", 1, { thinking: "user thinking somehow" }),
      msg("assistant", "Hi there!", 1, { thinking: "I should greet", tool_calls: [{ id: "x", name: "y", arguments: {} }] }),
    ];

    const compressed = compressTurn(turnMsgs);
    expect(compressed).toHaveLength(2);
    expect(compressed[0]).not.toHaveProperty("thinking");
    expect(compressed[1]).not.toHaveProperty("thinking");
    expect(compressed[1]).not.toHaveProperty("tool_calls");
  });

  it("should handle turn with only user message (no assistant reply)", () => {
    const turnMsgs = [msg("user", "Hello", 1)];
    const compressed = compressTurn(turnMsgs);
    expect(compressed).toHaveLength(1);
    expect(compressed[0]!.role).toBe("user");
  });

  it("should skip assistant messages with empty content", () => {
    const turnMsgs = [
      msg("user", "Do something", 1),
      msg("assistant", "", 1, { tool_calls: [{ id: "tc1", name: "action", arguments: {} }] }),
      msg("tool", "done", 1),
      // No final text reply from assistant
    ];

    const compressed = compressTurn(turnMsgs);
    expect(compressed).toHaveLength(1); // Only user message
  });
});

describe("compressForContext", () => {
  it("should keep all turns uncompressed when within fullDetailTurns", () => {
    const messages = [
      msg("user", "Hello", 1),
      msg("assistant", "Hi", 1),
      msg("user", "Help", 2),
      msg("assistant", "", 2, { tool_calls: [{ id: "tc1", name: "search", arguments: {} }] }),
      msg("tool", "result", 2, { tool_call_id: "tc1" }),
      msg("assistant", "Here you go", 2),
    ];

    const result = compressForContext(messages, 3);
    // All 6 messages should be kept (only 2 turns, under the 3-turn limit)
    expect(result).toHaveLength(6);
  });

  it("should compress old turns and keep recent turns full", () => {
    // Turn 1: user + tool_call + tool_result + assistant (4 msgs)
    // Turn 2: user + assistant (2 msgs)
    // Turn 3: user + tool_call + tool_result + assistant (4 msgs)
    // Turn 4: user + assistant (2 msgs)
    const messages: MessageData[] = [
      msg("user", "Search X", 1),
      msg("assistant", "", 1, { tool_calls: [{ id: "tc1", name: "search", arguments: {} }] }),
      msg("tool", "found X", 1, { tool_call_id: "tc1" }),
      msg("assistant", "X result", 1),
      msg("user", "Search Y", 2),
      msg("assistant", "Y result", 2),
      msg("user", "Search Z", 3),
      msg("assistant", "", 3, { tool_calls: [{ id: "tc2", name: "search", arguments: {} }] }),
      msg("tool", "found Z", 3, { tool_call_id: "tc2" }),
      msg("assistant", "Z result", 3),
      msg("user", "Summary", 4),
      msg("assistant", "Here's the summary", 4),
    ];

    // fullDetailTurns=2 → turns 3,4 keep full detail; turns 1,2 compressed
    const result = compressForContext(messages, 2);

    // Turn 1 compressed: user + assistant = 2
    // Turn 2 compressed: user + assistant = 2
    // Turn 3 full: 4 msgs
    // Turn 4 full: 2 msgs
    // Total: 10
    expect(result).toHaveLength(10);

    // First message should be from turn 1 (compressed)
    expect(result[0]!.content).toBe("Search X");
    expect(result[1]!.content).toBe("X result");
    // No tool messages from turn 1
    expect(result.filter((m) => m.role === "tool" && m.turnIndex === 1)).toHaveLength(0);

    // Turn 3 should have tool messages
    expect(result.filter((m) => m.role === "tool" && m.turnIndex === 3)).toHaveLength(1);
  });

  it("should strip thinking from all messages", () => {
    const messages = [
      msg("user", "Hello", 1),
      msg("assistant", "Hi", 1, { thinking: "Should I greet formally?" }),
    ];

    const result = compressForContext(messages, 3);
    expect(result).toHaveLength(2);
    expect(result[1]).not.toHaveProperty("thinking");
  });

  it("should return empty array for empty input", () => {
    expect(compressForContext([], 3)).toHaveLength(0);
  });
});
