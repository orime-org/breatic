// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The endpoint the timer knocks on (#186, design §4.6.1).
 *
 * The timer says one thing — "task xxx is out of time" — and knows nothing
 * else about it. Every judgement is here: a row still running becomes
 * expired and the node's counts go out; a row already terminal is left
 * alone, because the task finished before its deadline and the knock is
 * just the timer having no cancel.
 *
 * Both of those answer 200. A knock that gets a failure back is retried by
 * the timer forever, so the only thing that may fail here is something a
 * retry could fix.
 *
 * There is no session on this route. Our own Worker is the caller and the
 * shared secret is all it can prove, which is why the body carries a task id
 * and nothing that decides consequences.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SPACE = "33333333-3333-4333-8333-333333333333";
const NODE = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";

const SECRET = "test-ingest-secret";
const PATH = "/api/v1/canvas/node-tasks/expired";

const COUNTS = { running: 0, done: 0, failed: 0, expired: 1 };

/** The running row the timer's deadline belongs to. */
function runningRow(): Record<string, unknown> {
  return {
    id: TASK,
    projectId: PROJECT,
    spaceId: SPACE,
    nodeId: NODE,
    kind: "upload",
    status: "running",
    startedByUserId: "user-1",
    startedAt: new Date("2026-09-03T00:00:00.000Z"),
    budgetMs: 3_600_000,
    label: "clip.mp4",
    errorMessage: null,
    nodeHistoryId: null,
    deletedAt: null,
  };
}

/**
 * Knock on the endpoint the way the timer does.
 * @param secret - The shared secret header, omitted when null.
 * @returns The server's response.
 */
async function knock(secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== null) headers["x-ingest-secret"] = secret;

  return createApp().request(PATH, {
    method: "POST",
    headers,
    body: JSON.stringify({ task_id: TASK }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nodeTaskService.findById.mockResolvedValue(runningRow());
  mocks.nodeTaskService.settle.mockResolvedValue({
    applied: true,
    counts: COUNTS,
  });
});

describe("POST /canvas/node-tasks/expired", () => {
  it("refuses a caller without the shared secret", async () => {
    expect((await knock(null)).status).toBe(401);
    expect(mocks.nodeTaskService.settle).not.toHaveBeenCalled();
  });

  it("refuses a caller whose secret is wrong", async () => {
    expect((await knock("not-the-secret")).status).toBe(401);
    expect(mocks.nodeTaskService.settle).not.toHaveBeenCalled();
  });

  it("takes no session, so a signed-in user is not what it wants", async () => {
    // The anchor for the two above: without this the 401s would also be what
    // an endpoint that does not exist answers under the canvas group's auth.
    expect((await knock()).status).toBe(200);
  });

  it("moves a running row to expired", async () => {
    await knock();
    expect(mocks.nodeTaskService.settle).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, outcome: "expired" }),
    );
  });

  it("publishes the node's recounted numbers", async () => {
    await knock();
    expect(mocks.emitNodeTaskCounts).toHaveBeenCalledWith(
      expect.anything(),
      `project-${PROJECT}/canvas-${SPACE}`,
      NODE,
      COUNTS,
    );
  });

  it("leaves a row that already settled alone, and says so with a 200", async () => {
    // The timer has no cancel, so a task that finished before its deadline
    // still gets knocked on. Nothing to do, and nothing to retry.
    mocks.nodeTaskService.settle.mockResolvedValue({
      applied: false,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
    });

    expect((await knock()).status).toBe(200);
  });

  it("still publishes counts for a row that had already settled", async () => {
    // Cheap, and it repairs a node whose counts drifted: the numbers are
    // recomputed either way, so sending them costs one event and can only
    // bring a client closer to the table.
    mocks.nodeTaskService.settle.mockResolvedValue({
      applied: false,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
    });

    await knock();

    expect(mocks.emitNodeTaskCounts).toHaveBeenCalledWith(
      expect.anything(),
      `project-${PROJECT}/canvas-${SPACE}`,
      NODE,
      { running: 0, done: 1, failed: 0, expired: 0 },
    );
  });

  it("answers 200 for a task this table never held", async () => {
    // A knock for a row that is not there cannot be fixed by knocking
    // again. Answering anything else leaves the timer retrying forever.
    mocks.nodeTaskService.findById.mockResolvedValue(null);

    const res = await knock();

    expect(res.status).toBe(200);
    expect(mocks.nodeTaskService.settle).not.toHaveBeenCalled();
    expect(mocks.emitNodeTaskCounts).not.toHaveBeenCalled();
  });

  it("fails the knock when the table could not be reached", async () => {
    // The one thing a retry does fix. The timer keeps its alarm going and
    // this task still gets judged once the database is back.
    mocks.nodeTaskService.findById.mockRejectedValue(new Error("no database"));

    expect((await knock()).status).toBe(500);
  });

  it("rejects a malformed task id", async () => {
    const res = await createApp().request(PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ingest-secret": SECRET,
      },
      body: JSON.stringify({ task_id: "not-a-uuid" }),
    });
    expect(res.status).toBe(422);
  });
});
