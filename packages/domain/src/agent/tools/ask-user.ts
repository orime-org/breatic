// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Ask-user tool — pause the agent loop to request user input.
 *
 * Ported from backend/agent/tools/builtin/ask_user.py.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * Ask the user a clarifying question before proceeding.
 *
 * Returns the question and its suggested answers. The client picks the tool
 * part out of the stream by its own name and renders them; nothing has to be
 * parsed out of a marked-up string for that to work.
 */
const inputSchema = z.object({
  question: z.string().describe("The question to ask the user"),
  options: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of suggested answers for the user to choose from",
    ),
});

/** What the panel needs to put the question on screen. */
type AskUserPayload = { question: string; options: string[] };

export const askUser: Tool<z.infer<typeof inputSchema>, AskUserPayload> = tool({
  description:
    "Ask the user a clarifying question. Use when you need more " +
    "information to proceed. You can optionally provide a list of " +
    "suggested options for the user to choose from.",
  inputSchema,
  execute: async (
    input: z.infer<typeof inputSchema>,
    // Unused: this tool assembles a value and returns it, so there is nothing
    // to abandon. Declared so the shape is the same across every tool — the
    // reasoning lives in tools/__tests__/tool-cancellation.test.ts.
    _options: { abortSignal?: AbortSignal },
  ): Promise<AskUserPayload> => {
    const payload = { question: input.question, options: input.options ?? [] };
    return payload;
  },
});
