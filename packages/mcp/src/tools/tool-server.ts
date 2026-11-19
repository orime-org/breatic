// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The MCP server one call is served by (breatic#1488 §7): every tool, and
 * what every tool's answer carries besides its own result. The server cannot
 * send an agent anything it did not ask for (MCP Transports: servers do not
 * initiate requests), so the threads handed to the agent and the tasks that
 * ended ride on whatever the agent calls next.
 */

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { ServerApiError } from "@mcp/server-api.js";
import { ToolRefusal, type ToolDef, type ToolDeps } from "@mcp/tools/kit.js";

/** What the server is built with besides its tools. */
export interface ToolServerOptions {
  /** The cross-tool rules (§7.1), sent in the initialize result. */
  instructions?: string;
  /** A tool failed in a way the agent is not told the detail of. */
  onError?: (err: Error, tool: string) => void;
}

/** The reasons a server status is passed on under; others are internal errors. */
const SERVER_REFUSALS: Readonly<Record<number, string>> = {
  402: "insufficient_credits",
  403: "no_access",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  422: "invalid_request",
  429: "rate_limited",
  503: "busy",
  507: "storage_full",
};

/**
 * What the agent is told about a failed tool.
 * @param err - What the tool threw.
 * @returns The error body, or null when the detail stays with us.
 */
function refusalBody(err: unknown): Record<string, unknown> | null {
  if (err instanceof ToolRefusal) return { error: err.reason, message: err.message };
  if (err instanceof ServerApiError && SERVER_REFUSALS[err.status] !== undefined) {
    return {
      error: SERVER_REFUSALS[err.status],
      message: err.message,
      ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    };
  }
  return null;
}

/**
 * The reminders every answer carries. Each is read on a best-effort basis: a
 * tool's own result never fails because a reminder could not be read.
 * @param deps - The call.
 * @param onError - Where a failed read is reported.
 * @returns The reminder fields.
 */
async function reminders(deps: ToolDeps, onError: (err: Error) => void): Promise<Record<string, unknown>> {
  const [assignments, finished] = await Promise.allSettled([deps.api.get<unknown[]>("/agent/assignments"), deps.tasks.finished(deps.api)]);
  const out: Record<string, unknown> = {};
  if (assignments.status === "fulfilled") out.pendingAssignments = assignments.value.length;
  else onError(assignments.reason as Error);
  if (finished.status === "fulfilled") {
    if (finished.value.length > 0) out.finishedTasks = finished.value;
  } else onError(finished.reason as Error);
  return out;
}

/**
 * Build the server for one call.
 * @param deps - What the call's tools run on.
 * @param tools - The tools.
 * @param options - Instructions and error reporting.
 * @returns The server.
 */
export function buildToolServer(deps: ToolDeps, tools: readonly ToolDef[], options: ToolServerOptions): McpServer {
  const server = new McpServer({ name: "breatic", version: "1.0.0" }, options.instructions ? { instructions: options.instructions } : {});
  const onError = options.onError ?? (() => {});
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: tool.readOnly } },
      async (args: unknown): Promise<CallToolResult> => {
        let body: Record<string, unknown>;
        let isError = false;
        let images: CallToolResult["content"] = [];
        try {
          const out = await tool.run(deps, args as never);
          body = { result: out.value };
          images = (out.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
        } catch (err) {
          isError = true;
          const refusal = refusalBody(err);
          if (refusal === null) {
            onError(err instanceof Error ? err : new Error(String(err)), tool.name);
            body = { error: "internal", message: "Something went wrong on our side; nothing more is known. Read the Space again before retrying." };
          } else body = refusal;
        }
        Object.assign(body, await reminders(deps, (err) => onError(err, tool.name)));
        return { content: [{ type: "text", text: JSON.stringify(body) }, ...images], ...(isError ? { isError } : {}) };
      },
    );
  }
  return server;
}
