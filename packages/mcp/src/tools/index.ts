// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every tool the MCP service serves, and the cross-tool rules it sends in
 * the initialize result (breatic#1488 §7.1). A client may not show the
 * instructions to its model, so every rule an agent must follow is also in
 * the description of each tool it concerns.
 */

import { CANVAS_TOOLS } from "@mcp/tools/canvas-tools.js";
import { DOCUMENT_TOOLS } from "@mcp/tools/document-tools.js";
import { GENERATION_TOOLS } from "@mcp/tools/generation-tools.js";
import type { ToolDef } from "@mcp/tools/kit.js";
import { READ_TOOLS } from "@mcp/tools/read-tools.js";
import { RESULT_TOOLS } from "@mcp/tools/result-tools.js";

/** Every tool, in the order a client lists them. */
export const ALL_TOOLS: readonly ToolDef[] = [...READ_TOOLS, ...CANVAS_TOOLS, ...GENERATION_TOOLS, ...DOCUMENT_TOOLS, ...RESULT_TOOLS];

/** The rules that span tools. */
export const INSTRUCTIONS = [
  "breatic is a content-creation workspace: a Studio holds Projects, a Project holds Spaces (canvas, document, 3d, timeline). You act as the user who connected you, with their role and their credits.",
  "Each time you start working, call list_assignments first: the comment threads the user handed to you come before anything else. Do the work, then answer each in its thread.",
  "Read before you write (read_canvas, read_document), and look at what the user has selected or points at (the people field, or view_user_screen).",
  "A change that answers status: pending gives an operationId: fetch its outcome with get_operation_result, and do not send it again. When a change is refused, did not finish, or its result expired, read the Space again before deciding.",
  "Generation, mini-tools, understanding and transcription return a task id at once; their results arrive in finishedTasks on later answers, or ask get_task_result.",
  "Process files on your own machine (crop, rotate, cut, convert, mask) and upload the result; use our tools for what calls our models.",
].join("\n");
