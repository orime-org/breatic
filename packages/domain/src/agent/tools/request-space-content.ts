// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Request-space-content tool — ask the reader to let the agent read Spaces
 * other than the one they have open, and wait there for what they share
 * (inner#1552).
 */
import { getAgentConfig } from "@breatic/core";
import { spaceRequestInputSchema, type ChatSpace, type SpaceRequestInput } from "@breatic/shared";
import { tool, type Tool } from "ai";
import type { z } from "zod";

/** What a turn hands the tool when it builds it. */
export interface RequestSpaceContentContext {
  /** The Spaces this turn listed for the model; a call may name only these. */
  spaces?: readonly ChatSpace[];
}

/** What the model may send: the request, naming only Spaces in this turn's list. */
type RequestSchema = z.ZodType<SpaceRequestInput, SpaceRequestInput>;

/**
 * The request's shape, with what only this turn knows checked when the call
 * arrives: each id is in this turn's list and named once, a block range names
 * a document and node ids a canvas, and the configured caps hold.
 * @param context - This turn's Space list.
 * @returns The schema the tool takes.
 */
function schemaFor(context: RequestSpaceContentContext): RequestSchema {
  const listed = new Map((context.spaces ?? []).map((space) => [space.id, space]));
  const { space_request_max_spaces: maxSpaces, space_request_max_node_ids: maxNodeIds } = getAgentConfig();
  return spaceRequestInputSchema.superRefine((value, ctx) => {
    if (value.spaces.length > maxSpaces) {
      ctx.addIssue({
        code: "custom",
        path: ["spaces"],
        message: `One request names at most ${String(maxSpaces)} Spaces; this one names ${String(value.spaces.length)}.`,
      });
    }
    const seen = new Set<string>();
    value.spaces.forEach((asked, i) => {
      const space = listed.get(asked.id);
      if (space === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["spaces", i, "id"],
          message: `Space ${asked.id} is not in this turn's Space list; name a Space by the id the list gives it.`,
        });
        return;
      }
      if (seen.has(asked.id)) {
        ctx.addIssue({ code: "custom", path: ["spaces", i, "id"], message: `Space ${asked.id} is named twice; name each Space once.` });
      }
      seen.add(asked.id);
      if (asked.blocks !== undefined && space.kind !== "document") {
        ctx.addIssue({
          code: "custom",
          path: ["spaces", i, "blocks"],
          message: `Space ${asked.id} is a ${space.kind}; a range of blocks is asked for only from a document.`,
        });
      }
      if (asked.node_ids !== undefined && space.kind !== "canvas") {
        ctx.addIssue({
          code: "custom",
          path: ["spaces", i, "node_ids"],
          message: `Space ${asked.id} is a ${space.kind}; nodes are asked for only from a canvas.`,
        });
      }
      if (asked.node_ids !== undefined && asked.node_ids.length > maxNodeIds) {
        ctx.addIssue({
          code: "custom",
          path: ["spaces", i, "node_ids"],
          message: `Space ${asked.id} is asked for ${String(asked.node_ids.length)} nodes; one Space takes at most ${String(maxNodeIds)}.`,
        });
      }
    });
  });
}

/**
 * The request-space-content tool, as a turn receives it.
 *
 * It has no `execute`, like `ask_user`: a call is a card the reader answers,
 * the turn stops at it, and what they share comes back as this call's result
 * in the request that resumes the turn.
 * @param context - This turn's Space list.
 * @returns The tool.
 */
export function makeRequestSpaceContentTool(context: RequestSpaceContentContext): Tool<SpaceRequestInput, never> {
  return tool({
    description:
      "Ask the user to let you read Spaces in this project other than the one they have open, or a part of one " +
      "that came to you cut short. Name each Space by the id the Space list gives it, and say in `reason` why " +
      "you need it. Ask for a whole Space, or for part of one: `blocks` with `from` and an optional `to`, " +
      "counted by the `<!-- b:N -->` markers a document is read with, or `node_ids` naming canvas nodes. The " +
      "turn waits at the card. What comes back as this call's result is each Space as it was read (its " +
      "content, or why it could not be read), word that the user declined, or word that they wrote a message " +
      "instead, in which case read that message. Ask once per step: a second card in the same step is turned " +
      "away.",
    inputSchema: schemaFor(context),
  });
}
