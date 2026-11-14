// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The frames one run puts on its resumable stream (inner#1717).
 *
 * The wrapper owns everything about the wire that is not the turn's own
 * content: the first beat and the beats after it, holding the turn's error or
 * finish back until the run is settled, the `data-next-run` frame when the
 * conversation goes straight on to another run, and closing cleanly however
 * the turn or the settling failed. The turn here is a stream the case writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { HEARTBEAT_MS, errors } = vi.hoisted(() => ({ HEARTBEAT_MS: 5000, errors: [] as unknown[] }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...(actual.getAgentConfig as () => Record<string, unknown>)(),
      sse_heartbeat_interval_ms: HEARTBEAT_MS,
    }),
    logger: {
      error: (...args: unknown[]) => errors.push(args),
      warn: () => {},
      info: () => {},
      debug: () => {},
    },
  };
});

import type { UIMessageChunk } from "ai";
import { runWire } from "@server/agent/run-wire.js";

const CTX = { userId: "u-1", conversationId: "c-1", projectId: "p-1" };

/**
 * A turn that says the given chunks and ends.
 * @param chunks - What it says.
 * @returns The turn.
 */
function saying(...chunks: UIMessageChunk[]): () => Promise<ReadableStream<UIMessageChunk>> {
  return () =>
    Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      }),
    );
}

/**
 * Read a wire to its end and parse its frames.
 * @param wire - The SSE frames.
 * @returns Each frame's chunk, in order.
 */
async function framesOf(wire: ReadableStream<string>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const reader = wire.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += value;
  }
  for (const block of text.split("\n\n")) {
    if (!block.startsWith("data: ")) continue;
    out.push(JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  }
  return out;
}

/**
 * The types of frames, beats and the run's name left out.
 * @param frames - The frames.
 * @returns Their types.
 */
function typesOf(frames: Record<string, unknown>[]): unknown[] {
  return frames.filter((f) => f.type !== "data-heartbeat" && f.type !== "data-run").map((f) => f.type);
}

beforeEach(() => {
  errors.length = 0;
});

describe("the beat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the stream (ST-01)", async () => {
    const frames = await framesOf(
      runWire({ runId: "R1", ctx: CTX, turn: saying({ type: "finish" }), afterTurn: () => Promise.resolve(null) }),
    );
    expect(frames[0]).toEqual({ type: "data-heartbeat", transient: true, data: {} });
  });

  it("names its run right after the opening beat, so a page can stop the run it reads", async () => {
    const frames = await framesOf(
      runWire({ runId: "R1", ctx: CTX, turn: saying({ type: "finish" }), afterTurn: () => Promise.resolve(null) }),
    );
    expect(frames[1]).toEqual({ type: "data-run", transient: true, data: { runId: "R1" } });
  });

  it("keeps beating while the turn is silent, and leaves no timer behind (ST-02)", async () => {
    vi.useFakeTimers();
    const timersBefore = vi.getTimerCount();
    let end: (() => void) | undefined;
    const wire = runWire({
      runId: "R1",
      ctx: CTX,
      turn: () =>
        Promise.resolve(
          new ReadableStream<UIMessageChunk>({
            start(controller) {
              end = () => {
                controller.enqueue({ type: "finish" });
                controller.close();
              };
            },
          }),
        ),
      afterTurn: () => Promise.resolve(null),
    });
    const reading = framesOf(wire);
    await vi.advanceTimersByTimeAsync(12_000);
    end?.();
    const frames = await reading;
    expect(frames.filter((f) => f.type === "data-heartbeat")).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});

describe("a turn that fails", () => {
  it("logs once, writes the failure and the error frame, and closes cleanly when the turn throws (ST-04)", async () => {
    const afterTurn = vi.fn().mockResolvedValue(null);
    const frames = await framesOf(
      runWire({ runId: "R1", ctx: CTX, turn: () => Promise.reject(new Error("history read failed")), afterTurn }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual([expect.objectContaining({ err: expect.any(Error), conversationId: "c-1" }), expect.any(String)]);
    expect(typesOf(frames)).toEqual(["data-failed", "error"]);
    expect(afterTurn).toHaveBeenCalledTimes(1);
  });

  it("closes cleanly with the error frame when settling throws (ST-06)", async () => {
    const frames = await framesOf(
      runWire({
        runId: "R1",
        ctx: CTX,
        turn: saying({ type: "text-start", id: "t" }, { type: "finish" }),
        afterTurn: () => Promise.reject(new Error("redis refused")),
      }),
    );
    expect(errors).toHaveLength(1);
    expect(typesOf(frames).at(-1)).toBe("error");
    expect(typesOf(frames)).not.toContain("data-next-run");
  });

  it("writes no next run when the next run's opening throws (ST-07)", async () => {
    const frames = await framesOf(
      runWire({
        runId: "R1",
        ctx: CTX,
        turn: saying({ type: "finish" }),
        afterTurn: () => Promise.reject(new Error("next opening failed")),
      }),
    );
    expect(errors).toHaveLength(1);
    expect(typesOf(frames)).not.toContain("data-next-run");
  });

  it("ends with the failure, then the error frame, nothing after (ST-08)", async () => {
    const frames = await framesOf(
      runWire({
        runId: "R1",
        ctx: CTX,
        turn: saying(
          { type: "text-start", id: "t" },
          { type: "data-thinking-time", data: { ms: 900 } },
          { type: "data-failed", data: {} },
          { type: "error", errorText: "x" },
          { type: "finish" },
        ),
        afterTurn: () => Promise.resolve(null),
      }),
    );
    expect(typesOf(frames).slice(-3)).toEqual(["data-thinking-time", "data-failed", "error"]);
  });

  it("holds the error frame back until the next run is open, then names it first (ST-09)", async () => {
    const order: string[] = [];
    const wire = runWire({
      runId: "R1",
      ctx: CTX,
      turn: saying(
        { type: "data-thinking-time", data: { ms: 900 } },
        { type: "data-failed", data: {} },
        { type: "error", errorText: "x" },
      ),
      afterTurn: async () => {
        order.push("settled");
        return "R2";
      },
    });
    const frames = await framesOf(wire);
    expect(order).toEqual(["settled"]);
    expect(typesOf(frames).slice(-4)).toEqual(["data-thinking-time", "data-failed", "data-next-run", "error"]);
    expect(frames.find((f) => f.type === "data-next-run")).toEqual({ type: "data-next-run", transient: true, data: { runId: "R2" } });
  });
});

describe("a turn that ends", () => {
  it("puts the next run after the stop mark and before the finish (ST-11b)", async () => {
    const frames = await framesOf(
      runWire({
        runId: "R1",
        ctx: CTX,
        turn: saying({ type: "text-start", id: "t" }, { type: "data-interrupted", data: {} }, { type: "finish" }),
        afterTurn: () => Promise.resolve("R2"),
      }),
    );
    expect(typesOf(frames).slice(-3)).toEqual(["data-interrupted", "data-next-run", "finish"]);
  });

  it("writes no next run when none opened (ST-11, ST-13)", async () => {
    const frames = await framesOf(
      runWire({
        runId: "R1",
        ctx: CTX,
        turn: saying({ type: "data-thinking-time", data: { ms: 1 } }, { type: "data-truncated", data: {} }, { type: "finish" }),
        afterTurn: () => Promise.resolve(null),
      }),
    );
    expect(typesOf(frames).slice(-3)).toEqual(["data-thinking-time", "data-truncated", "finish"]);
    expect(typesOf(frames)).not.toContain("data-next-run");
  });

  it("puts the next run after the turn's last marks and before the finish (ST-13b)", async () => {
    const frames = await framesOf(
      runWire({
        runId: "R1",
        ctx: CTX,
        turn: saying({ type: "data-thinking-time", data: { ms: 1 } }, { type: "data-truncated", data: {} }, { type: "finish" }),
        afterTurn: () => Promise.resolve("R2"),
      }),
    );
    expect(typesOf(frames).slice(-4)).toEqual(["data-thinking-time", "data-truncated", "data-next-run", "finish"]);
  });
});
