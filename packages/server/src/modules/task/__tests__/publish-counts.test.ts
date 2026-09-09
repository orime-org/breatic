// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Publishing four numbers that nobody is waiting on (#186, design §4.6.4).
 *
 * A node's task counts go out on the cross-service stream so that everyone
 * else with this canvas open sees them move. The request that caused the
 * move already has its own answer in hand, and the reader on the other end
 * of that request is not the audience for the broadcast.
 *
 * So the two are separated here. Losing the stream for a few seconds is a
 * network incident on infrastructure that is being split into independent
 * instances; what it must not do is take down the answer to a request that
 * already succeeded. It is logged, because the alternative is an outage
 * nobody can see afterwards.
 *
 * The broadcast that carries a task's CONTENT is a different thing and does
 * not come through here: that one is the only way a finished result reaches
 * the node, so losing it has to fail the caller and let the retry happen.
 * `emitNodeTaskCounts` takes that one, and its fifth parameter is required,
 * so a counts-only call cannot be written against it by accident.
 */

import type * as coreModule from "@breatic/core";
import { describe, it, expect, vi, beforeEach } from "vitest";

const emit = vi.fn();
const logError = vi.fn();

vi.mock("@breatic/domain", () => ({ emitNodeTaskCounts: emit }));

vi.mock("@breatic/core", async () => {
  const actual = await vi.importActual<typeof coreModule>("@breatic/core");
  return {
    AppError: actual.AppError,
    getStreamRedis: () => ({}),
    logger: { error: logError, warn: vi.fn(), info: vi.fn() },
  };
});

const { publishCountsQuietly } = await import(
  "@server/modules/task/publish-counts.js"
);

const DOC = "canvas:project-1:space-1";
const NODE = "44444444-4444-4444-8444-444444444444";
const COUNTS = { running: 1, done: 2, failed: 0, expired: 0 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publishing a node's counts as a courtesy", () => {
  it("sends the four numbers and no content", async () => {
    await publishCountsQuietly(DOC, NODE, COUNTS);

    expect(emit).toHaveBeenCalledWith({}, DOC, NODE, COUNTS, undefined);
  });

  it("does not throw when the stream cannot be reached", async () => {
    emit.mockRejectedValueOnce(new Error("stream is down"));

    await expect(
      publishCountsQuietly(DOC, NODE, COUNTS),
    ).resolves.toBeUndefined();
  });

  it("logs what was lost, so the outage leaves a trace", async () => {
    const err = new Error("stream is down");
    emit.mockRejectedValueOnce(err);

    await publishCountsQuietly(DOC, NODE, COUNTS);

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err, docName: DOC, nodeId: NODE }),
      "node_task_counts_publish_failed",
    );
  });
});
