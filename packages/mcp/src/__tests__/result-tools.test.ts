// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OperationOutcome } from "@mcp/command-channel.js";
import { getOperationResult, getTaskResult, listAssignments, viewUserScreen } from "@mcp/tools/result-tools.js";
import type { TaskRow } from "@mcp/tools/task-tracker.js";
import { stubDeps } from "@mcp/__tests__/tool-deps.js";

const PROJECT = randomUUID();
const SPACE = randomUUID();

/**
 * A task row.
 * @param taskId - The task.
 * @param status - Its status.
 * @param over - Fields to replace.
 * @returns The row.
 */
function row(taskId: string, status: TaskRow["status"], over: Partial<TaskRow> = {}): TaskRow {
  return { taskId, projectId: PROJECT, spaceId: SPACE, nodeId: `node-${taskId}`, status, content: null, errorMessage: null, ...over };
}

describe("get_task_result", () => {
  it("reports each task's nodes as running, succeeded, failed or timed out, and an unknown id as not found", async () => {
    const [running, done, failed, expired, unknown] = ["t1", "t2", "t3", "t4", "t5"];
    const rows = [row(running, "running"), row(done, "done", { content: "https://cdn/x.png" }), row(failed, "failed", { errorMessage: "Unsafe prompt" }), row(expired, "expired")];
    const { deps, calls, sent } = stubDeps({ api: () => rows });
    const { value } = await getTaskResult.run(deps, { taskIds: [running, done, failed, expired, unknown] });
    expect(calls).toEqual([{ method: "GET", path: "/canvas/node-tasks", query: { ids: "t1,t2,t3,t4,t5" } }]);
    expect(value).toEqual({
      tasks: [
        { taskId: running, status: "running", nodes: [{ projectId: PROJECT, spaceId: SPACE, nodeId: "node-t1", status: "running" }] },
        { taskId: done, status: "succeeded", nodes: [{ projectId: PROJECT, spaceId: SPACE, nodeId: "node-t2", status: "succeeded", result: "https://cdn/x.png" }] },
        { taskId: failed, status: "failed", nodes: [{ projectId: PROJECT, spaceId: SPACE, nodeId: "node-t3", status: "failed", error: "Unsafe prompt" }] },
        { taskId: expired, status: "timed_out", nodes: [{ projectId: PROJECT, spaceId: SPACE, nodeId: "node-t4", status: "timed_out", error: "timed out" }] },
        { taskId: unknown, status: "not_found" },
      ],
    });
    expect(deps.tasks.forget).toHaveBeenCalledWith([done, failed, expired]);
    expect(sent.map((c) => [c.type, c.projectId, c.spaceId, c.params])).toEqual([
      ["touch_presence", PROJECT, SPACE, { focus: ["node-t1", "node-t2", "node-t3", "node-t4"] }],
    ]);
  });

  it("calls a task with one node still running and another ended still running", async () => {
    const { deps } = stubDeps({ api: () => [row("t", "done"), row("t", "running", { nodeId: "other" })] });
    const { value } = (await getTaskResult.run(deps, { taskIds: ["t"] })) as { value: { tasks: Array<{ status: string }> } };
    expect(value.tasks[0]!.status).toBe("running");
    expect(deps.tasks.forget).toHaveBeenCalledWith([]);
  });
});

/**
 * Deps whose command channel answers an operation lookup with `outcome`.
 * @param outcome - The outcome.
 * @param api - The server's answers.
 * @returns The stubbed deps.
 */
function withOperation(outcome: OperationOutcome, api?: (call: unknown) => unknown): ReturnType<typeof stubDeps> {
  const stubbed = stubDeps(api ? { api } : {});
  stubbed.deps.commands.operationResult = vi.fn(async () => outcome);
  return stubbed;
}

const PLACE = { projectId: PROJECT, spaceId: SPACE };

describe("get_operation_result", () => {
  it("returns the result of a command that finished, and keeps the agent shown where it ran", async () => {
    const { deps, sent } = withOperation({ kind: "reply", reply: { callId: "op", status: "done", result: { nodeIds: ["n"] } }, type: "create_canvas_nodes", place: PLACE });
    expect((await getOperationResult.run(deps, { operationId: randomUUID() })).value).toEqual({ nodeIds: ["n"] });
    expect(sent.map((c) => [c.type, c.projectId, c.spaceId])).toEqual([["touch_presence", PROJECT, SPACE]]);
  });

  it("reports the files a deletion left unused, as the deletion tool does", async () => {
    const result = { deleted: ["n"], kept: [], deletedAssets: [{ fileUrl: "https://cdn/x.png", kind: "image", nodeId: "n", spaceId: SPACE }] };
    const { deps, calls } = withOperation({ kind: "reply", reply: { callId: "op", status: "done", result }, type: "delete_canvas_nodes", place: PLACE }, () => ({ ok: true }));
    expect((await getOperationResult.run(deps, { operationId: randomUUID() })).value).toEqual({ deleted: ["n"], kept: [] });
    expect(calls.map((c) => c.path)).toEqual(["/assets/deleted"]);
  });

  it("says a command is still running", async () => {
    const { deps } = withOperation({ kind: "running", type: "read_canvas", place: PLACE });
    expect((await getOperationResult.run(deps, { operationId: randomUUID() })).value).toEqual({ status: "running" });
  });

  it("says the user was not looking when a screenshot never came", async () => {
    const { deps } = withOperation({ kind: "unfinished", type: "view_user_screen", place: { projectId: PROJECT, spaceId: null } });
    expect((await getOperationResult.run(deps, { operationId: randomUUID() })).value).toMatchObject({ watching: false });
  });

  it("refuses a command that did not finish, one that was refused, and a result that expired", async () => {
    const unfinished = withOperation({ kind: "unfinished", type: "update_canvas_node", place: PLACE });
    await expect(getOperationResult.run(unfinished.deps, { operationId: randomUUID() })).rejects.toMatchObject({ reason: "unfinished" });
    const refused = withOperation({ kind: "reply", reply: { callId: "op", status: "rejected", reason: "locked" }, type: "update_canvas_node", place: PLACE });
    await expect(getOperationResult.run(refused.deps, { operationId: randomUUID() })).rejects.toMatchObject({ reason: "locked" });
    const expired = withOperation({ kind: "expired" });
    await expect(getOperationResult.run(expired.deps, { operationId: randomUUID() })).rejects.toMatchObject({ reason: "expired" });
  });
});

describe("list_assignments", () => {
  it("lists the threads handed to this agent that still wait, oldest first, with their Space and where each is", async () => {
    const [canvas, doc] = [randomUUID(), randomUUID()];
    const giver = randomUUID();
    const records = [
      { projectId: PROJECT, spaceId: doc, threadId: "t-doc", assignedAt: 20 },
      { projectId: PROJECT, spaceId: canvas, threadId: "t-canvas", assignedAt: 10 },
    ];
    const { deps, submitted } = stubDeps({
      api: (call) => (call.path === "/agent/assignments" ? records : call.path === "/users" ? [{ id: giver, username: "Ada" }] : []),
      reply: (command) => {
        if (command.type === "list_spaces") {
          return { status: "done", result: { spaces: [{ id: canvas, type: "canvas", name: "Board" }, { id: doc, type: "document", name: "Script" }, { id: randomUUID(), type: "canvas", name: "Other" }] } };
        }
        if (command.type === "read_canvas_assignments") {
          return { status: "done", result: { assignments: [{ threadId: "t-canvas", assignedBy: giver, assignedAt: 10, pin: { x: 1, y: 2, nodeIds: ["n"], groupId: null } }] } };
        }
        return { status: "done", result: { assignments: [{ threadId: "t-doc", assignedBy: giver, assignedAt: 20, blockId: "b1", quotedText: "words" }] } };
      },
    });
    const { value } = await listAssignments.run(deps, {});
    expect(submitted.map((c) => [c.type, c.spaceId]).sort()).toEqual(
      [
        ["list_spaces", null],
        ["read_canvas_assignments", canvas],
        ["read_document_assignments", doc],
      ].sort(),
    );
    expect(value).toEqual({
      assignments: [
        { projectId: PROJECT, spaceId: canvas, spaceType: "canvas", spaceName: "Board", threadId: "t-canvas", assignedBy: giver, assignedAt: 10, pin: { x: 1, y: 2, nodeIds: ["n"], groupId: null } },
        { projectId: PROJECT, spaceId: doc, spaceType: "document", spaceName: "Script", threadId: "t-doc", assignedBy: giver, assignedAt: 20, blockId: "b1", quotedText: "words" },
      ],
      names: { users: { [giver]: "Ada" }, agents: {} },
    });
  });

  it("asks collab nothing when nothing is handed over", async () => {
    const { deps, submitted } = stubDeps({ api: () => [] });
    expect((await listAssignments.run(deps, {})).value).toEqual({ assignments: [], names: { users: {}, agents: {} } });
    expect(submitted).toEqual([]);
  });

  it("says which Spaces it could not read in time", async () => {
    const { deps } = stubDeps({
      api: (call) => (call.path === "/agent/assignments" ? [{ projectId: PROJECT, spaceId: SPACE, threadId: "t", assignedAt: 1 }] : []),
      reply: (command) => (command.type === "list_spaces" ? { status: "done", result: { spaces: [{ id: SPACE, type: "canvas", name: "Board" }] } } : "pending"),
    });
    expect((await listAssignments.run(deps, {})).value).toMatchObject({ assignments: [], unread: [{ projectId: PROJECT, spaceId: SPACE }] });
  });
});

describe("view_user_screen", () => {
  it("returns the screenshot as an image with what is on screen", async () => {
    const view = { spaceId: SPACE, type: "canvas", nodeIds: ["n"] };
    const { deps, submitted } = stubDeps({ reply: () => ({ status: "done", result: { mimeType: "image/webp", imageBase64: "aGk=", view } }) });
    expect(await viewUserScreen.run(deps, { projectId: PROJECT })).toEqual({ value: { watching: true, view }, images: [{ data: "aGk=", mimeType: "image/webp" }] });
    expect(submitted.map((c) => [c.type, c.projectId, c.spaceId])).toEqual([["view_user_screen", PROJECT, null]]);
  });

  it("says when the user is not looking at the project, or has no Space open", async () => {
    const away = stubDeps({ reply: () => ({ status: "done", result: { watching: false } }) });
    expect((await viewUserScreen.run(away.deps, { projectId: PROJECT })).value).toMatchObject({ watching: false });
    const noted = stubDeps({ reply: () => ({ status: "done", result: { note: "No Space is open" } }) });
    expect((await viewUserScreen.run(noted.deps, { projectId: PROJECT })).value).toEqual({ watching: true, note: "No Space is open" });
  });
});
