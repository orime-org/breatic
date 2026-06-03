// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * propose-canvas-action tool — interaction tool for suggesting canvas
 * mutations.
 *
 * Per spec/07-chat-agent.md §10.18.4 (v13 Agent rich output protocol):
 * the LLM uses this to propose adding / updating / deleting canvas
 * nodes. The frontend renders a button "+ apply (N nodes)" with the
 * agent's rationale; user clicks → frontend writes Yjs (does the
 * canvas mutation locally). Backend does NOT mutate canvas — that's
 * frontend's job per spec §12.3 (user-driven control) + memory canvas
 * architecture (frontend owns node creation).
 */
import { tool } from "ai";
import { z } from "zod";

/** Sentinel detected by main-agent to interrupt the loop and yield AGENT_CANVAS_ACTION SSE event. */
export const PROPOSE_CANVAS_ACTION_SENTINEL = "__PROPOSE_CANVAS_ACTION__";

const inputSchema = z.object({
  action: z
    .enum(["create_nodes", "update_node", "delete_node"])
    .describe("The kind of canvas mutation being proposed"),
  nodes: z
    .array(
      z.object({
        type: z
          .enum(["image", "video", "audio", "text", "generative", "annotation"])
          .describe("Node type per spec/03-data-model §5.3.2"),
        position: z
          .object({ x: z.number(), y: z.number() })
          .describe("ReactFlow canvas coordinates"),
        data: z
          .record(z.string(), z.unknown())
          .describe("Per-type data fields (see spec/03-data-model §5.3.2.1)"),
      }),
    )
    .optional()
    .describe(
      "Required for action='create_nodes' or 'update_node'; omit for 'delete_node'",
    ),
  rationale: z
    .string()
    .describe("Brief explanation shown to the user for why this action is proposed"),
});

export const proposeCanvasAction = tool({
  description:
    "Propose creating / updating / deleting nodes on the user's " +
    "active canvas Space. The user sees a button + rationale and " +
    "decides whether to apply. Use when the user asks for canvas " +
    "creation help (e.g. 'add 3 storyboard frames' / 'remove the " +
    "draft nodes'). DO NOT call for Document or Timeline Spaces — " +
    "those Space types are not yet supported by this protocol.",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>): Promise<string> => {
    return `${PROPOSE_CANVAS_ACTION_SENTINEL}${JSON.stringify(input)}`;
  },
});
