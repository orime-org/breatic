// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * This service and the browser describe the chat stream with one vocabulary,
 * and put it on the wire in the shape both of them read.
 *
 * What is NOT tested here is that the contract lists every event this service
 * sends. Every event on this stream is built by `sse()`, and the compiler
 * settles that path: `sse()` takes an `SSEEventName`, so an undeclared name
 * fails to compile — `tsc --noEmit` on `this.sse("brand_new_event", ...)`
 * gives `TS2345: Argument of type '"brand_new_event"' is not assignable to
 * parameter of type 'SSEEventName'`. A test asserting the same could only
 * restate it.
 *
 * That covers the path, not the socket. `routes/chat.ts` writes to a
 * `StreamingApi` whose `write` takes any string, so a hand-built frame would
 * reach the browser unchecked — `routes/text-tools.ts` builds its frames that
 * way for the other stream. Both chat writes go through `serializeSSE` today.
 * That is how the route is written, not something the compiler enforces, and
 * a test cannot settle it either: what it would have to check is that no
 * future line writes a frame by hand, which is a fact about code not yet
 * written.
 *
 * Nor is there anything here about a name the contract declares but nothing
 * emits, because the contract does not carry such names. `agent_thinking` was
 * the standing example while it was unbuilt; PR-3 batch 6 built it (spec item
 * 27: the backend emits it and the browser renders it), so its name joined
 * the contract in the same change that started emitting it — which is the
 * rule, not an exception to it.
 * A contract that lists what does not run is a contract that lies,
 * and an earlier version of this file tried to manage that lie by scanning
 * source text for emit sites — which cannot work, since whether something is
 * emitted is a runtime fact and text is not.
 *
 * So what is left are the two things that can actually drift.
 */
import { describe, it, expect } from "vitest";

import { SSE_EVENT_NAMES } from "@breatic/shared";

import { SSEEventType, serializeSSE } from "@server/agent/types.js";

/**
 * The `data:` payload of a serialized event, parsed back.
 * @param wire - The output of `serializeSSE`.
 * @returns The JSON object the browser would receive.
 * @throws {Error} When the output has no readable `data:` line.
 */
function payloadOf(wire: string): Record<string, unknown> {
  const line = wire.split("\n").find((l) => l.startsWith("data: "));
  if (line === undefined) throw new Error(`no data line in: ${JSON.stringify(wire)}`);
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

describe("this service's event names are the shared contract", () => {
  // `toBe`, not `toEqual`: the point is that there is one object, not two that
  // happen to agree today. A second declaration here — which is how the
  // backend and the browser drifted apart in the first place — passes
  // `toEqual` for exactly as long as nobody edits either copy.
  it("is the same object, not a copy that currently agrees", () => {
    expect(SSEEventType).toBe(SSE_EVENT_NAMES);
  });
});

describe("what goes on the wire", () => {
  it("names the event on the SSE event line and in the payload", () => {
    const wire = serializeSSE({ event: SSEEventType.CHAT_CHUNK, data: { text: "hi" } });
    expect(wire.startsWith(`event: ${SSEEventType.CHAT_CHUNK}\n`)).toBe(true);
    expect(payloadOf(wire).event).toBe(SSEEventType.CHAT_CHUNK);
  });

  it("carries the task id snake_case, the way the browser reads it", () => {
    const payload = payloadOf(
      serializeSSE({ event: SSEEventType.CHAT_DONE, taskId: "task-7", data: {} }),
    );
    expect(payload).toHaveProperty("task_id", "task-7");
    expect(payload).not.toHaveProperty("taskId");
  });

  // The one field carrying content: the chunk text, the error message, every
  // interaction widget's payload. Everything else on the frame is routing.
  it("hands the payload through untouched", () => {
    const data = { text: "hi", nested: { n: 1, list: [true, null] } };
    expect(payloadOf(serializeSSE({ event: SSEEventType.CHAT_CHUNK, data })).data).toEqual(data);
  });

  it("ends with the blank line that closes an SSE frame", () => {
    expect(serializeSSE({ event: SSEEventType.ERROR, data: {} }).endsWith("\n\n")).toBe(true);
  });
});
