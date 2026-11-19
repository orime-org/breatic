// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A video mini-tool run's end (inner#1306 execution design §11.4 run end): before a run's final state is written, every
 * model step still unresolved (a ticket or a send mark and no end) is abandoned through provider, and the costs the
 * abandon hands over end the step `failed` (`timeout` when the run's deadline ended it). The domain's step functions and
 * the media runner are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as domainModule from "@breatic/domain";
import { abandonUnresolvedModelSteps } from "@worker/handlers/mini-tool/run-end.js";

const h = vi.hoisted(() => ({ unresolved: vi.fn(), end: vi.fn(), abandon: vi.fn() }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, listUnresolvedMiniToolModelSteps: h.unresolved, endMiniToolModelStep: h.end };
});
vi.mock("@worker/handlers/model-task.js", async (original) => ({ ...await original<Record<string, unknown>>(), mediaRunner: () => ({ abandon: h.abandon }) }));

const TASK = "50000000-0000-4000-8000-000000000003";
const PENDING = { state: "pending" as const, lookup: { upstream: "wavespeed", predictionId: "p-9" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.end.mockResolvedValue(undefined);
  h.abandon.mockReturnValue({ costs: [PENDING] });
});

describe("abandoning a run's unresolved model steps", () => {
  it("ends each unresolved step with what its abandon hands over", async () => {
    h.unresolved.mockResolvedValue([{ stepId: "s1", ticket: { version: 3 } }, { stepId: "s2", ticket: null }]);
    await abandonUnresolvedModelSteps(TASK, "failed");
    expect(h.abandon).toHaveBeenCalledTimes(1);
    expect(h.abandon).toHaveBeenCalledWith({ version: 3 });
    expect(h.end).toHaveBeenCalledWith({ taskId: TASK, stepId: "s1", end: expect.objectContaining({ kind: "failed", category: "failed" }), costs: [PENDING], servedBy: "wavespeed" });
    expect(h.end).toHaveBeenCalledWith({ taskId: TASK, stepId: "s2", end: expect.objectContaining({ kind: "failed", category: "failed" }), costs: [], servedBy: null });
  });

  it("ends them timeout when the run's deadline ended it", async () => {
    h.unresolved.mockResolvedValue([{ stepId: "s1", ticket: { version: 1 } }]);
    await abandonUnresolvedModelSteps(TASK, "deadline");
    expect(h.end).toHaveBeenCalledWith(expect.objectContaining({ end: expect.objectContaining({ category: "timeout" }) }));
  });

  it("does nothing for a run with no unresolved step", async () => {
    h.unresolved.mockResolvedValue([]);
    await abandonUnresolvedModelSteps(TASK, "failed");
    expect(h.abandon).not.toHaveBeenCalled();
    expect(h.end).not.toHaveBeenCalled();
  });
});
