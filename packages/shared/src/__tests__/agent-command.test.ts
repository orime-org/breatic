// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The contract between the MCP service and collab for external-agent commands
 * (breatic#1488 §6): the Redis key names both sides build from the deployment
 * prefix, the command envelope both sides validate, the reply collab writes,
 * and the ids a command derives from its call id so a re-run writes the same
 * nodes and blocks.
 */

import { describe, it, expect } from "vitest";

import {
  AGENT_COMMAND_STREAM_MAXLEN,
  agentCommandSchema,
  agentReplySchema,
  callScopedId,
  mcpCaptureRequestKey,
  mcpCommandStreamKey,
  mcpDoneChannel,
  mcpInFlightTasksKey,
  mcpOperationKey,
  mcpReplyKey,
} from "@shared/agent-command.js";

const CALL = "0b6f3a3e-4b3a-4d0e-9a51-1f2d3c4b5a69";
const USER = "5c1a9a52-6e0b-4c38-9f0c-0d4b7f2a1e33";
const CONNECTION = "a7d0c2e4-3f1b-4c5a-8e9d-6b2a1c0f9e87";
const PROJECT = "3e9b1d7c-2a4f-4b6e-8c0d-5f1a2b3c4d5e";
const SPACE = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

/**
 * A command that passes the schema, with the given fields replaced.
 * @param over - Fields to replace.
 * @returns The command object.
 */
function command(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callId: CALL,
    type: "read_canvas",
    userId: USER,
    connectionId: CONNECTION,
    credentialId: "grant_123",
    projectId: PROJECT,
    spaceId: SPACE,
    params: { nodeIds: ["n1"] },
    submittedAt: 1_000,
    deadlineAt: 46_000,
    ...over,
  };
}

describe("Redis key names", () => {
  it("builds every key from the deployment prefix", () => {
    expect(mcpCommandStreamKey("dev")).toBe("dev:mcp:commands");
    expect(mcpReplyKey("dev", CALL)).toBe(`dev:mcp:reply:${CALL}`);
    expect(mcpOperationKey("dev", CALL)).toBe(`dev:mcp:op:${CALL}`);
    expect(mcpDoneChannel("dev")).toBe("dev:mcp:done");
    expect(mcpInFlightTasksKey("dev", CONNECTION)).toBe(`dev:mcp:tasks:${CONNECTION}`);
    expect(mcpCaptureRequestKey("dev", "req-1")).toBe("dev:mcp:capture-request:req-1");
  });

  it("keeps two deployments apart", () => {
    expect(mcpCommandStreamKey("dev-agent")).not.toBe(mcpCommandStreamKey("dev"));
    expect(mcpDoneChannel("prod")).toBe("prod:mcp:done");
  });

  it("caps the command stream at the same length as every other stream", () => {
    expect(AGENT_COMMAND_STREAM_MAXLEN).toBe(10_000);
  });
});

describe("agentCommandSchema", () => {
  it("accepts a complete command and keeps every field", () => {
    expect(agentCommandSchema.parse(command())).toEqual(command());
  });

  it("accepts a command with no Space, for commands that only touch the Project", () => {
    expect(agentCommandSchema.parse(command({ spaceId: null })).spaceId).toBeNull();
  });

  it("rejects a command without a deadline", () => {
    const { deadlineAt: _dropped, ...rest } = command();
    expect(agentCommandSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects ids that are not uuids", () => {
    for (const field of ["callId", "userId", "connectionId", "projectId"]) {
      expect(agentCommandSchema.safeParse(command({ [field]: "not-a-uuid" })).success).toBe(false);
    }
  });

  it("rejects an empty credential id", () => {
    expect(agentCommandSchema.safeParse(command({ credentialId: "" })).success).toBe(false);
  });
});

describe("agentReplySchema", () => {
  it("accepts the three outcomes a command can end in", () => {
    expect(agentReplySchema.parse({ callId: CALL, status: "done", result: { ok: 1 } })).toEqual({
      callId: CALL,
      status: "done",
      result: { ok: 1 },
    });
    expect(agentReplySchema.parse({ callId: CALL, status: "rejected", reason: "locked" })).toEqual({
      callId: CALL,
      status: "rejected",
      reason: "locked",
    });
    expect(agentReplySchema.parse({ callId: CALL, status: "unfinished" })).toEqual({
      callId: CALL,
      status: "unfinished",
    });
  });

  it("requires a reason on a rejection", () => {
    expect(agentReplySchema.safeParse({ callId: CALL, status: "rejected" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(agentReplySchema.safeParse({ callId: CALL, status: "running" }).success).toBe(false);
  });
});

describe("callScopedId", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("gives the same id for the same call and slot, so a re-run writes the same node", () => {
    expect(callScopedId(CALL, "node:0")).toBe(callScopedId(CALL, "node:0"));
    expect(callScopedId(CALL, "node:0")).toMatch(UUID);
  });

  it("gives different ids for different slots of one call", () => {
    expect(callScopedId(CALL, "node:0")).not.toBe(callScopedId(CALL, "node:1"));
    expect(callScopedId(CALL, "node:0")).not.toBe(callScopedId(CALL, "edge:0"));
  });

  it("gives different ids for the same slot of different calls", () => {
    const other = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    expect(callScopedId(CALL, "node:0")).not.toBe(callScopedId(other, "node:0"));
  });
});
