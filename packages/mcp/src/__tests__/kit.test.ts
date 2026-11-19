// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { mcpConfigSchema } from "@breatic/core";
import type { AgentCommand } from "@breatic/shared";
import { describe, expect, it, vi } from "vitest";
import type { CommandChannel, SubmitOutcome } from "@mcp/command-channel.js";
import { outcomeValue, runCommand, runCommandNow, ToolRefusal, touchPresence, type ToolDeps } from "@mcp/tools/kit.js";

const PROJECT = randomUUID();
const SPACE = randomUUID();

/**
 * Tool deps over a command channel that answers `outcome`.
 * @param outcome - What submit answers, built from the command it got.
 * @param startedAt - When the call began.
 * @returns The deps and the commands sent.
 */
function depsWith(outcome: (c: AgentCommand) => SubmitOutcome, startedAt = Date.now()): { deps: ToolDeps; submitted: Array<{ command: AgentCommand; waitMs: number }>; sent: AgentCommand[] } {
  const submitted: Array<{ command: AgentCommand; waitMs: number }> = [];
  const sent: AgentCommand[] = [];
  const commands: CommandChannel = {
    submit: vi.fn(async (command: AgentCommand, waitMs: number) => {
      submitted.push({ command, waitMs });
      return outcome(command);
    }),
    send: vi.fn(async (command: AgentCommand) => {
      sent.push(command);
    }),
    operationResult: vi.fn(),
    close: vi.fn(),
  };
  const deps = {
    call: { downstreamToken: "t", userId: randomUUID(), connectionId: randomUUID(), credential: { type: "pat" as const, tokenId: "tok" }, startedAt },
    api: {} as ToolDeps["api"],
    commands,
    tasks: {} as ToolDeps["tasks"],
    config: mcpConfigSchema.parse({}),
  };
  return { deps, submitted, sent };
}

describe("runCommand", () => {
  it("sends the command as the call's user and connection, due at the call's deadline, and returns collab's result", async () => {
    const startedAt = Date.now();
    const { deps, submitted } = depsWith((c) => ({ kind: "reply", reply: { callId: c.callId, status: "done", result: { spaces: [] } } }), startedAt);
    const outcome = await runCommand(deps, { type: "list_spaces", projectId: PROJECT, spaceId: null, params: {} });
    expect(outcome).toEqual({ kind: "done", result: { spaces: [] } });
    const [{ command, waitMs }] = submitted as [(typeof submitted)[number]];
    expect(command).toMatchObject({
      type: "list_spaces",
      userId: deps.call.userId,
      connectionId: deps.call.connectionId,
      credential: deps.call.credential,
      projectId: PROJECT,
      spaceId: null,
      params: {},
      deadlineAt: startedAt + deps.config.call_timeout_ms,
    });
    expect(waitMs).toBe(deps.config.command_wait_ms);
  });

  it("waits no longer than what is left of the call", async () => {
    const { deps, submitted } = depsWith((c) => ({ kind: "submitted", callId: c.callId }), Date.now() - (45_000 - 2_000));
    await runCommand(deps, { type: "list_spaces", projectId: PROJECT, spaceId: null, params: {} });
    expect(submitted[0]!.waitMs).toBeLessThanOrEqual(2_000);
    expect(submitted[0]!.waitMs).toBeGreaterThan(1_000);
  });

  it("hands back the operation id when no reply came in the wait", async () => {
    const { deps } = depsWith((c) => ({ kind: "submitted", callId: c.callId }));
    const outcome = await runCommand(deps, { type: "read_canvas", projectId: PROJECT, spaceId: SPACE, params: {} });
    expect(outcome.kind).toBe("pending");
    expect(outcomeValue(outcome)).toMatchObject({ status: "pending", operationId: (outcome as { operationId: string }).operationId });
  });

  it("refuses with collab's reason and says what was wrong", async () => {
    const { deps } = depsWith((c) => ({ kind: "reply", reply: { callId: c.callId, status: "rejected", reason: "locked" } }));
    const err = await runCommand(deps, { type: "lock_canvas_nodes", projectId: PROJECT, spaceId: SPACE, params: { nodeIds: ["n"] } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolRefusal);
    expect(err).toMatchObject({ reason: "locked" });
    expect((err as Error).message).toMatch(/locked/);
  });

  it("passes on a reason it does not know as it is", async () => {
    const { deps } = depsWith((c) => ({ kind: "reply", reply: { callId: c.callId, status: "rejected", reason: "something_new" } }));
    await expect(runCommand(deps, { type: "list_spaces", projectId: PROJECT, spaceId: null, params: {} })).rejects.toMatchObject({ reason: "something_new", message: "something_new" });
  });

  it("tells the agent to read again when the command did not finish", async () => {
    const { deps } = depsWith((c) => ({ kind: "reply", reply: { callId: c.callId, status: "unfinished" } }));
    await expect(runCommand(deps, { type: "list_spaces", projectId: PROJECT, spaceId: null, params: {} })).rejects.toMatchObject({ reason: "unfinished" });
  });
});

describe("runCommandNow", () => {
  it("refuses with the operation id when a step it needs has no reply yet", async () => {
    const { deps } = depsWith((c) => ({ kind: "submitted", callId: c.callId }));
    const err = await runCommandNow(deps, { type: "list_spaces", projectId: PROJECT, spaceId: null, params: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "busy" });
    expect((err as Error).message).toMatch(/get_operation_result/);
  });
});

describe("touchPresence", () => {
  it("sends a light command naming the nodes the call works on", async () => {
    const { deps, sent, submitted } = depsWith(() => {
      throw new Error("not submitted");
    });
    await touchPresence(deps, PROJECT, SPACE, ["n1"]);
    await touchPresence(deps, PROJECT, null);
    expect(submitted).toEqual([]);
    expect(sent.map((c) => [c.type, c.spaceId, c.params])).toEqual([
      ["touch_presence", SPACE, { focus: ["n1"] }],
      ["touch_presence", null, {}],
    ]);
  });
});
