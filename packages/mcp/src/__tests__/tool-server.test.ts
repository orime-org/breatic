// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { mcpConfigSchema } from "@breatic/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ServerApiError, type ServerApi } from "@mcp/server-api.js";
import { defineTool, ToolRefusal, type ToolDeps } from "@mcp/tools/kit.js";
import type { FinishedTask, TaskTracker } from "@mcp/tools/task-tracker.js";
import { buildToolServer } from "@mcp/tools/tool-server.js";
import { connectClient } from "@mcp/__tests__/mcp-client.js";

const FINISHED: FinishedTask = {
  taskId: randomUUID(),
  projectId: randomUUID(),
  spaceId: randomUUID(),
  nodeId: randomUUID(),
  status: "done",
  content: "https://cdn/x.png",
  errorMessage: null,
  tool: "run_generation",
};

/**
 * Deps whose server answers the assignment list with `assignments`.
 * @param assignments - What `GET /agent/assignments` answers, or an error to throw.
 * @param finished - What the task tracker reports.
 * @returns The deps.
 */
function depsWith(assignments: unknown[] | Error, finished: FinishedTask[] = []): ToolDeps {
  const api: ServerApi = {
    get: async <T>(path: string): Promise<T> => {
      if (path !== "/agent/assignments") throw new Error(`unexpected ${path}`);
      if (assignments instanceof Error) throw assignments;
      return assignments as T;
    },
    post: async () => {
      throw new Error("not used");
    },
  };
  const tasks: TaskTracker = { track: vi.fn(), finished: vi.fn(async () => finished), forget: vi.fn() };
  return {
    call: { downstreamToken: "t", userId: randomUUID(), connectionId: randomUUID(), credential: { type: "pat", tokenId: "x" }, startedAt: Date.now() },
    api,
    commands: { submit: vi.fn(), send: vi.fn(), operationResult: vi.fn(), close: vi.fn() },
    tasks,
    config: mcpConfigSchema.parse({}),
    report: vi.fn(),
  };
}

const echo = defineTool({
  name: "echo",
  description: "Echo the word back.",
  input: z.object({ word: z.string().describe("The word.") }),
  readOnly: true,
  run: async (_deps, { word }) => ({ value: { word } }),
});

const refuse = defineTool({
  name: "refuse",
  description: "Always refused.",
  input: z.object({}),
  readOnly: false,
  run: async () => {
    throw new ToolRefusal("locked", "A node the call changes is locked.");
  },
});

const broke = defineTool({
  name: "broke",
  description: "Throws an internal error.",
  input: z.object({}),
  readOnly: true,
  run: async () => {
    throw new Error("secret stack detail");
  },
});

const poor = defineTool({
  name: "poor",
  description: "The server says the user has no credits.",
  input: z.object({}),
  readOnly: false,
  run: async () => {
    throw new ServerApiError(402, "Insufficient credits: required 5, available 1");
  },
});

const picture = defineTool({
  name: "picture",
  description: "Returns an image.",
  input: z.object({}),
  readOnly: true,
  run: async () => ({ value: { spaceId: "s" }, images: [{ data: "aGk=", mimeType: "image/webp" }] }),
});

const malformed = defineTool({
  name: "malformed",
  description: "Builds a command the shared format refuses.",
  input: z.object({}),
  readOnly: false,
  run: async () => {
    z.object({ nodeIds: z.array(z.string()).min(1) }).parse({ nodeIds: [] });
    return { value: null };
  },
});

const TOOLS = [echo, refuse, broke, poor, picture, malformed];

describe("buildToolServer", () => {
  it("lists each tool with its description, input schema and whether it only reads, and sends the instructions", async () => {
    const client = await connectClient(buildToolServer(depsWith([]), TOOLS, { instructions: "Call list_assignments first." }));
    expect((await client.initialize()).instructions).toBe("Call list_assignments first.");
    const listed = await client.listTools();
    expect(listed.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
      ["echo", true],
      ["refuse", false],
      ["broke", true],
      ["poor", false],
      ["picture", true],
      ["malformed", false],
    ]);
    expect(listed[0]!.description).toBe("Echo the word back.");
    expect(listed[0]!.inputSchema).toMatchObject({ type: "object", properties: { word: { type: "string", description: "The word." } } });
  });

  it("answers with the result, the count of threads handed to the agent and the tasks that finished", async () => {
    const client = await connectClient(buildToolServer(depsWith([{ threadId: "a" }, { threadId: "b" }], [FINISHED]), TOOLS, {}));
    await client.initialize();
    expect(await client.callJson("echo", { word: "hi" })).toEqual({
      isError: false,
      body: {
        result: { word: "hi" },
        pendingAssignments: 2,
        finishedTasks: [{ taskId: FINISHED.taskId, tool: "run_generation", projectId: FINISHED.projectId, spaceId: FINISHED.spaceId, nodeId: FINISHED.nodeId, status: "succeeded", result: "https://cdn/x.png" }],
      },
    });
  });

  it("leaves out finishedTasks when none finished", async () => {
    const client = await connectClient(buildToolServer(depsWith([]), TOOLS, {}));
    await client.initialize();
    expect((await client.callJson("echo", { word: "hi" })).body).toEqual({ result: { word: "hi" }, pendingAssignments: 0 });
  });

  it("answers a refusal as an error result that still carries the reminders", async () => {
    const client = await connectClient(buildToolServer(depsWith([{ threadId: "a" }]), TOOLS, {}));
    await client.initialize();
    expect(await client.callJson("refuse", {})).toEqual({
      isError: true,
      body: { error: "locked", message: "A node the call changes is locked.", pendingAssignments: 1 },
    });
  });

  it("passes on the server's own words for a refused request, such as running out of credits", async () => {
    const client = await connectClient(buildToolServer(depsWith([]), TOOLS, {}));
    await client.initialize();
    expect(await client.callJson("poor", {})).toMatchObject({
      isError: true,
      body: { error: "insufficient_credits", message: "Insufficient credits: required 5, available 1" },
    });
  });

  it("hides an internal error's detail from the agent and reports it", async () => {
    const onError = vi.fn();
    const client = await connectClient(buildToolServer(depsWith([]), TOOLS, { onError }));
    await client.initialize();
    const { isError, body } = await client.callJson("broke", {});
    expect(isError).toBe(true);
    expect(body.error).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret stack detail");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "secret stack detail" }), "broke");
  });

  it("still answers when the reminders cannot be read", async () => {
    const onError = vi.fn();
    const client = await connectClient(buildToolServer(depsWith(new ServerApiError(429, "Too many requests")), TOOLS, { onError }));
    await client.initialize();
    expect(await client.callJson("echo", { word: "hi" })).toEqual({ isError: false, body: { result: { word: "hi" } } });
  });

  it("puts images after the JSON as image content", async () => {
    const client = await connectClient(buildToolServer(depsWith([]), TOOLS, {}));
    await client.initialize();
    const result = await client.callTool("picture", {});
    expect(result.content[1]).toEqual({ type: "image", data: "aGk=", mimeType: "image/webp" });
  });
});

describe("a command the shared format refuses", () => {
  it("is answered as an invalid request naming the field", async () => {
    const client = await connectClient(buildToolServer(depsWith([]), TOOLS, {}));
    await client.initialize();
    const { isError, body } = await client.callJson("malformed", {});
    expect(isError).toBe(true);
    expect(body.error).toBe("invalid_request");
    expect(String(body.message)).toContain("nodeIds");
  });
});
