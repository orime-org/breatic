/**
 * Ask-user tool — pause the agent loop to request user input.
 *
 * Ported from backend/agent/tools/builtin/ask_user.py.
 *
 * @module
 */
import { tool } from "ai";
import { z } from "zod";

/** Sentinel prefix detected by the tool-call runner to interrupt the loop. */
export const ASK_USER_SENTINEL = "__ASK_USER__";

/**
 * Ask the user a clarifying question before proceeding.
 *
 * Returns a sentinel string `__ASK_USER__{json}` that the runner
 * detects to pause the tool-call loop and surface the question to
 * the frontend.
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

export const askUser = tool({
  description:
    "Ask the user a clarifying question. Use when you need more " +
    "information to proceed. You can optionally provide a list of " +
    "suggested options for the user to choose from.",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>): Promise<string> => {
    const payload = { question: input.question, options: input.options ?? [] };
    return `${ASK_USER_SENTINEL}${JSON.stringify(payload)}`;
  },
});
