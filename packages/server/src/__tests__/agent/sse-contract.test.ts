// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * This service and the browser describe the chat stream with one vocabulary,
 * and put it on the wire in the shape both of them read.
 *
 * What is NOT tested here is that the contract lists every event the backend
 * can send. The compiler already settles that: `sse()` takes an
 * `SSEEventName`, so a name the contract does not declare fails to compile —
 * `tsc --noEmit` on `this.sse("brand_new_event", ...)` gives
 * `TS2345: Argument of type '"brand_new_event"' is not assignable to
 * parameter of type 'SSEEventName'`. A test asserting the same thing could
 * only restate it.
 *
 * Nor is there anything here about a name the contract declares but nothing
 * emits, because the contract does not carry such names. `agent_thinking` is
 * a feature PR-3 batch 6 builds (spec item 27: the backend emits it and the
 * browser renders it); its name joins the contract when it is emitted, not
 * before. A contract that lists what does not run is a contract that lies,
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

  it("ends with the blank line that closes an SSE frame", () => {
    expect(serializeSSE({ event: SSEEventType.ERROR, data: {} }).endsWith("\n\n")).toBe(true);
  });
});
