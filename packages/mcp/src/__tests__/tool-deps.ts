// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { mcpConfigSchema } from "@breatic/core";
import type { AgentCommand, AgentReply } from "@breatic/shared";
import { vi } from "vitest";
import type { QueryValue, ServerApi } from "@mcp/server-api.js";
import type { ToolDeps } from "@mcp/tools/kit.js";

/** One server request a tool made. */
export interface ApiCall {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

/** Stubbed deps and what the tool did with them. */
export interface StubbedDeps {
  deps: ToolDeps;
  /** Commands submitted and waited on. */
  submitted: AgentCommand[];
  /** Light commands sent. */
  sent: AgentCommand[];
  /** Server requests. */
  calls: ApiCall[];
  /** Tasks the tool listed. */
  tracked: Array<{ taskId: string; tool: string }>;
  /** Failures the tool answered past. */
  reported: Array<{ err: Error; context: Record<string, unknown> }>;
}

/** How the stubs answer. */
export interface StubAnswers {
  /** collab's reply to a submitted command; omitted means a `{}` result. */
  reply?: (command: AgentCommand) => Omit<AgentReply, "callId"> | "pending";
  /** The server's answer to a request; throw to refuse it. */
  api?: (call: ApiCall) => unknown;
}

/**
 * Tool deps whose collab and server answer as told.
 * @param answers - How they answer.
 * @returns The deps and records of what was asked.
 */
export function stubDeps(answers: StubAnswers = {}): StubbedDeps {
  const submitted: AgentCommand[] = [];
  const sent: AgentCommand[] = [];
  const calls: ApiCall[] = [];
  const tracked: Array<{ taskId: string; tool: string }> = [];
  const reported: Array<{ err: Error; context: Record<string, unknown> }> = [];
  const respond = (call: ApiCall): unknown => {
    calls.push(call);
    return answers.api ? answers.api(call) : undefined;
  };
  const api: ServerApi = {
    get: async <T>(path: string, query?: Record<string, QueryValue>): Promise<T> => respond({ method: "GET", path, ...(query ? { query } : {}) }) as T,
    post: async <T>(path: string, body: unknown, options: { idempotencyKey?: string; headers?: Record<string, string> } = {}): Promise<T> =>
      respond({ method: "POST", path, body, ...options }) as T,
  };
  const deps: ToolDeps = {
    call: { downstreamToken: "t", userId: randomUUID(), connectionId: randomUUID(), credential: { type: "pat", tokenId: "tok" }, startedAt: Date.now() },
    api,
    commands: {
      submit: vi.fn(async (command: AgentCommand) => {
        submitted.push(command);
        const reply = answers.reply ? answers.reply(command) : { status: "done" as const, result: {} };
        return reply === "pending" ? { kind: "submitted" as const, callId: command.callId } : { kind: "reply" as const, reply: { ...reply, callId: command.callId } as AgentReply };
      }),
      send: vi.fn(async (command: AgentCommand) => {
        sent.push(command);
      }),
      operationResult: vi.fn(),
      close: vi.fn(),
    },
    tasks: {
      track: vi.fn(async (taskId: string, tool: string) => {
        tracked.push({ taskId, tool });
      }),
      finished: vi.fn(async () => []),
      forget: vi.fn(async () => undefined),
    },
    config: mcpConfigSchema.parse({}),
    report: (err, context) => {
      reported.push({ err, context });
    },
  };
  return { deps, submitted, sent, calls, tracked, reported };
}
