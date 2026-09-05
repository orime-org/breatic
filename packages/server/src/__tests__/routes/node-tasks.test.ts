// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two endpoints the task list needs (#186, design §7.4 / §7.5).
 *
 * `GET /canvas/nodes/:nodeId/tasks` — the panel pulls its rows from here, not
 * from the canvas document. The document carries four numbers; the detail is
 * fetched when the user asks to see it. Asking is also the one moment a task
 * that outran its budget is judged dead (design §4.6), and the four numbers
 * that judgement produced are republished (design §4.6.4): the document and
 * the table are not kept in lock step, and this is how a node showing a count
 * the table no longer holds gets back to the truth.
 *
 * `DELETE /canvas/node-tasks/:taskId` — one endpoint for both "finish" and
 * "clear", because the server decides from the row's current state which one
 * this is. A row still running is neither, and it says so.
 *
 * Both guard on the project the ROW names, never the one the request names.
 * The path carries a task id, which any logged-in user could guess; reading
 * the project from the row is what stops that id from reaching another
 * tenant's data. The request's own project only comes into play when the
 * table does not hold the row at all — the user is clearing something off
 * a projection the server cannot see, and something still has to be counted.
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

const AUTH = { Cookie: "breatic_session=valid-token" };

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const SPACE = "33333333-3333-4333-8333-333333333333";
const NODE = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";

const ZERO = { running: 0, done: 0, failed: 0, expired: 0 };

/** A settled row, the shape the service hands back. */
function settledRow(): Record<string, unknown> {
  return {
    id: TASK,
    projectId: PROJECT,
    spaceId: SPACE,
    nodeId: NODE,
    kind: "upload",
    status: "failed",
    startedByUserId: "user-1",
    startedAt: new Date("2026-09-03T00:00:00.000Z"),
    budgetMs: 3_600_000,
    label: "clip.mp4",
    errorMessage: "part 3 never arrived",
    nodeHistoryId: null,
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectService.assertAccess.mockResolvedValue(undefined);
  mocks.nodeTaskService.listLive.mockResolvedValue([]);
  // `clearAllMocks` forgets calls, not implementations, so counts set by one
  // case would otherwise be what the next one reads.
  mocks.nodeTaskService.countsFor.mockResolvedValue(ZERO);
  mocks.nodeTaskService.harvestAndList.mockResolvedValue({
    tasks: [],
    counts: ZERO,
  });
  mocks.nodeTaskService.findById.mockResolvedValue(settledRow());
  mocks.nodeTaskService.dismiss.mockResolvedValue({
    removed: true,
    counts: ZERO,
  });
});

describe("GET /canvas/nodes/:nodeId/tasks", () => {
  const listUrl = `/api/v1/canvas/nodes/${NODE}/tasks?project_id=${PROJECT}&space_id=${SPACE}`;

  it("requires auth", async () => {
    const path = listUrl;
    const res = await createApp().request(path);
    expect(res.status).toBe(401);

    // Anchor: the canvas group's auth middleware answers 401 for any path
    // under it, existing or not, so the line above passes for free while
    // there is no such endpoint. This is what makes it about auth.
    const signedIn = await createApp().request(path, { headers: AUTH });
    expect(signedIn.status).not.toBe(404);
  });

  it("hands back every live row on the node", async () => {
    mocks.nodeTaskService.harvestAndList.mockResolvedValue({
      tasks: [settledRow()],
      counts: ZERO,
    });

    const res = await createApp().request(listUrl, { headers: AUTH });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tasks: unknown[] } };
    expect(body.data.tasks).toHaveLength(1);
  });

  it("harvests before it reads, so no answer carries a row the budget already ended", async () => {
    const res = await createApp().request(listUrl, { headers: AUTH });

    expect(res.status).toBe(200);
    // Reading this list is the only moment a task is judged dead (#186,
    // design §4.6). Calling the plain readers instead would answer from the
    // table untouched, leaving a row that ran out saying `running` — and the
    // node it hangs on undeletable — until some other request moved it.
    expect(mocks.nodeTaskService.harvestAndList).toHaveBeenCalledWith({
      projectId: PROJECT,
      nodeId: NODE,
    });
    expect(mocks.nodeTaskService.listLive).not.toHaveBeenCalled();
    expect(mocks.nodeTaskService.countsFor).not.toHaveBeenCalled();
  });

  it("lets anyone who can see the project read it", async () => {
    await createApp().request(listUrl, { headers: AUTH });
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(
      PROJECT,
      "user-1",
      "viewer",
    );
  });

  it("refuses a project the caller has no access to", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(
      new mocks.appError(403, "forbidden"),
    );

    const res = await createApp().request(
      `/api/v1/canvas/nodes/${NODE}/tasks?project_id=${OTHER_PROJECT}&space_id=${SPACE}`,
      { headers: AUTH },
    );

    expect(res.status).toBe(403);
    // The guard runs before the read, and the read is also what expires rows —
    // so a caller with no access cannot make the table move either.
    expect(mocks.nodeTaskService.harvestAndList).not.toHaveBeenCalled();
  });

  it("rejects a malformed node id before it reaches a query", async () => {
    const res = await createApp().request(
      `/api/v1/canvas/nodes/not-a-uuid/tasks?project_id=${PROJECT}&space_id=${SPACE}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(422);
  });

  it("publishes the node's counts, so a stale projection is pulled back", async () => {
    // The counts published are the ones the harvest produced, so a row this
    // very request just expired is in the numbers every client receives.
    mocks.nodeTaskService.harvestAndList.mockResolvedValue({
      tasks: [],
      counts: { running: 0, done: 3, failed: 1, expired: 0 },
    });

    await createApp().request(listUrl, { headers: AUTH });

    expect(mocks.emitNodeTaskCounts).toHaveBeenCalledWith(
      expect.anything(),
      `project-${PROJECT}/canvas-${SPACE}`,
      NODE,
      { running: 0, done: 3, failed: 1, expired: 0 },
    );
  });

  it("publishes all four zeros when the node has no tasks left", async () => {
    mocks.nodeTaskService.harvestAndList.mockResolvedValue({
      tasks: [],
      counts: ZERO,
    });

    await createApp().request(listUrl, { headers: AUTH });

    expect(mocks.emitNodeTaskCounts).toHaveBeenCalledWith(
      expect.anything(),
      `project-${PROJECT}/canvas-${SPACE}`,
      NODE,
      ZERO,
    );
  });

  it("refuses a request that does not say which space", async () => {
    const res = await createApp().request(
      `/api/v1/canvas/nodes/${NODE}/tasks?project_id=${PROJECT}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(422);
  });
});

describe("DELETE /canvas/node-tasks/:taskId", () => {
  const url =
    `/api/v1/canvas/node-tasks/${TASK}` +
    `?project_id=${PROJECT}&space_id=${SPACE}&node_id=${NODE}`;

  it("requires auth", async () => {
    const res = await createApp().request(url, { method: "DELETE" });
    expect(res.status).toBe(401);

    // Same anchor as the list endpoint: 401 is the group middleware's
    // answer for any unknown path too.
    const signedIn = await createApp().request(url, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(signedIn.status).not.toBe(404);
  });

  it("clears the record and answers with the node's new counts", async () => {
    mocks.nodeTaskService.dismiss.mockResolvedValue({
      removed: true,
      counts: { running: 1, done: 0, failed: 0, expired: 0 },
    });

    const res = await createApp().request(url, {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { removed: boolean; counts: typeof ZERO };
    };
    expect(body.data).toEqual({
      removed: true,
      counts: { running: 1, done: 0, failed: 0, expired: 0 },
    });
  });

  it("guards on the project the row names, not the one the request names", async () => {
    // The row lives in PROJECT; the request claims OTHER_PROJECT. A caller
    // who may write OTHER_PROJECT must not reach this row through it.
    const res = await createApp().request(
      `/api/v1/canvas/node-tasks/${TASK}` +
        `?project_id=${OTHER_PROJECT}&space_id=${SPACE}&node_id=${NODE}`,
      { method: "DELETE", headers: AUTH },
    );

    expect(res.status).toBe(200);
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(
      PROJECT,
      "user-1",
      "editor",
    );
    expect(mocks.projectService.assertAccess).not.toHaveBeenCalledWith(
      OTHER_PROJECT,
      "user-1",
      "editor",
    );
  });

  it("demands write access, not just sight of the project", async () => {
    await createApp().request(url, { method: "DELETE", headers: AUTH });
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(
      PROJECT,
      "user-1",
      "editor",
    );
  });

  it("refuses a caller who cannot write that project", async () => {
    mocks.projectService.assertAccess.mockRejectedValue(
      new mocks.appError(403, "forbidden"),
    );

    const res = await createApp().request(url, {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(403);
    expect(mocks.nodeTaskService.dismiss).not.toHaveBeenCalled();
  });

  it("falls back to the request's own project when no row exists", async () => {
    // Design §7.4: the user is clearing something off a projection the
    // server cannot see. There is no row to read a project from, so the
    // guard runs against what the caller says — and the caller still has
    // to prove they may write it.
    mocks.nodeTaskService.findById.mockResolvedValue(null);

    const res = await createApp().request(url, {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(
      PROJECT,
      "user-1",
      "editor",
    );
    expect(mocks.nodeTaskService.dismiss).toHaveBeenCalledWith({
      taskId: TASK,
      projectId: PROJECT,
      nodeId: NODE,
    });
  });

  it("publishes the recounted numbers so every client's node follows", async () => {
    mocks.nodeTaskService.dismiss.mockResolvedValue({
      removed: true,
      counts: { running: 0, done: 2, failed: 0, expired: 0 },
    });

    await createApp().request(url, { method: "DELETE", headers: AUTH });

    expect(mocks.emitNodeTaskCounts).toHaveBeenCalledWith(
      expect.anything(),
      `project-${PROJECT}/canvas-${SPACE}`,
      NODE,
      { running: 0, done: 2, failed: 0, expired: 0 },
    );
  });

  it("passes a still-running refusal through as a conflict", async () => {
    mocks.nodeTaskService.dismiss.mockRejectedValue(
      new mocks.appError(409, "still running"),
    );

    const res = await createApp().request(url, {
      method: "DELETE",
      headers: AUTH,
    });

    expect(res.status).toBe(409);
    expect(mocks.emitNodeTaskCounts).not.toHaveBeenCalled();
  });

  it("rejects a malformed task id before it reaches a query", async () => {
    const res = await createApp().request(
      `/api/v1/canvas/node-tasks/not-a-uuid?project_id=${PROJECT}&node_id=${NODE}`,
      { method: "DELETE", headers: AUTH },
    );
    expect(res.status).toBe(422);
  });
});
