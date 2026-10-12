// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the model was given for each tool call, written down with the turn.
 *
 * Replay hands this back as it is. Working it out again from the tool's raw
 * answer each turn meant reading rows written by an older version of a tool
 * with today's code, and the first field a tool's answer gained after rows
 * existed made every later turn of those conversations throw (inner#1481).
 */

import type { Tool, ToolResultPart } from "ai";
import { logger } from "@breatic/core";
import type { MessagePart, StoredModelOutput } from "@breatic/shared";

/**
 * What the model reads for a result it can no longer be shown.
 *
 * Two rows reach it: one written before the model's copy was kept, whose raw
 * answer this code does not read, and one whose copy could not be worked out
 * when it was written. Either way the model can call the tool again.
 */
export const EARLIER_RESULT_NOTE =
  "[This result was recorded by an earlier version and is no longer available. Call the tool again if you need it.]";

/** A tool part, once narrowed out of the union. */
type ToolPart = Extract<MessagePart, { type: "tool" }>;

/** What the SDK sends the model for one tool call. */
type ToolResultOutput = ToolResultPart["output"];

/**
 * The value the SDK sends the model for one successful call.
 *
 * The rule `createToolModelOutput` applies with `errorMode: "none"` (`ai/internal`):
 * the tool's own `toModelOutput` when it declares one, otherwise a string as
 * text and anything else as JSON. A test holds the two side by side.
 * @param tool - The tool as the turn ran it.
 * @param part - The call that answered.
 * @returns What the model was given.
 */
async function sdkOutputOf(tool: Tool, part: ToolPart): Promise<ToolResultOutput> {
  if (tool.toModelOutput !== undefined) {
    return await tool.toModelOutput({
      toolCallId: part.toolCallId,
      input: part.input,
      output: part.output,
    });
  }
  return typeof part.output === "string"
    ? { type: "text", value: part.output }
    : { type: "json", value: (part.output ?? null) as Extract<ToolResultOutput, { type: "json" }>["value"] };
}

/**
 * Narrow what the SDK sent to the arms the store keeps.
 *
 * Text and JSON are the two every provider takes and that stay put across SDK
 * versions. The others are the SDK's own structures; storing one fixes a shape
 * an upgrade may change, which is the failure this record exists to end.
 * @param output - What the model was given.
 * @returns The same value, in the stored shape.
 * @throws {Error} When it is an arm the store does not keep.
 */
function stored(output: ToolResultOutput): StoredModelOutput {
  switch (output.type) {
    case "text":
      return { type: "text", value: output.value };
    case "json":
      return { type: "json", value: output.value };
    case "content":
    case "error-text":
    case "error-json":
    case "execution-denied":
      throw new Error(`a successful call converted to the "${output.type}" arm, which is not stored`);
    default: {
      const unhandled: never = output;
      throw new Error(`unknown tool result arm: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Write down what the model was given for every call in a reply that answered.
 *
 * One call that cannot be worked out is logged and stored with the note, and
 * the rest go on: this runs ahead of the steps that store the reply and bill
 * the turn, and losing either over one result is worse than losing the result.
 * @param parts - The reply's parts, every call settled.
 * @param tools - The tool set the turn ran with.
 * @param context - What the log line needs to place a failure.
 * @param context.conversationId - The conversation the reply belongs to.
 * @returns The same parts, each successful call carrying `forModel`.
 */
export async function withModelOutputs(
  parts: readonly MessagePart[],
  tools: Readonly<Record<string, Tool>>,
  context: { conversationId: string },
): Promise<MessagePart[]> {
  return Promise.all(
    parts.map(async (part): Promise<MessagePart> => {
      if (part.type !== "tool" || part.status !== "success") return part;
      try {
        const tool = tools[part.toolName];
        if (tool === undefined) throw new Error("the tool is not in the turn's tool set");
        return { ...part, forModel: stored(await sdkOutputOf(tool, part)) };
      } catch (err) {
        logger.error(
          {
            err,
            conversationId: context.conversationId,
            toolName: part.toolName,
            toolCallId: part.toolCallId,
          },
          "tool_model_output_failed",
        );
        return { ...part, forModel: { type: "text", value: EARLIER_RESULT_NOTE } };
      }
    }),
  );
}
