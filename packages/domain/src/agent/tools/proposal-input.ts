// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the proposal tool takes from the model, and the verdict its checks give.
 */
import { z } from "zod";

import {
  GENERATION_NODE_MODES,
  MAX_NODE_NAME_LEN,
  PANEL_EDITOR_PARAM,
  markReadsBack,
  type GenerationNodeType,
} from "@breatic/shared";

import type { Refusal } from "@domain/agent/tools/proposal-refusals.js";
import { SAVE_IMAGE } from "@domain/agent/tools/tool-names.js";
import { readerUrlSchema } from "@domain/asset/source-url.js";

/** Whether a proposal holds together, and which refusal it meets when it does not. */
export type ProposalVerdict = { ok: true } | Refusal;

const NODE_TYPES = Object.keys(GENERATION_NODE_MODES) as [
  GenerationNodeType,
  ...GenerationNodeType[],
];

// Every string below that a card puts on screen is trimmed before it is
// measured: one made of spaces passes a length check and then draws a bullet
// with nothing beside it, or a mark naming nothing. The prompt's own text is
// the exception and is left alone -- a segment of one space is how two marks
// are kept apart, and trimming it would run them together.
/** Why a label holding its own closing bracket or a line break is refused: written out, it would not read back. */
const LABEL_BRACKET = "A label may not hold the bracket that closes its mark (} for tweak, ) for note) or a line break.";

const promptSegment = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z
    .object({
      ref: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "An @ of the node at this index in nodes, written into the prompt for the reader: it lands as the " +
            "same mention they would insert by hand. Use it for every node wired into this node's pool, " +
            "wherever the prompt speaks of it",
        ),
    })
    .strict(),
  z
    .object({
      slot: z.union([
        z
          .object({
            kind: z.literal("tweak").describe("Words only the reader can write"),
            label: z.string().trim().min(1).describe("What to write"),
            note: z
              .string()
              .trim()
              .min(1)
              .describe("The line this puts on the card"),
          })
          .strict()
          .refine(markReadsBack, { message: LABEL_BRACKET }),
        z
          .object({
            kind: z
              .literal("note")
              .describe(
                "How to operate the panel, never sent to the model: which slot to pick a node into, or what " +
                  "to do first with a node the prompt @s that lands empty (put a file in it, or generate it)",
              ),
            label: z.string().trim().min(1).describe("The note, which is also the card's line"),
          })
          .strict()
          .refine(markReadsBack, { message: LABEL_BRACKET }),
      ]),
    })
    .strict(),
]);

const proposalNode = z
  .object({
    role: z
      .enum(["source", "generate", "written"])
      .describe("written holds finished words; source holds material, or stands empty for the reader to fill"),
    type: z.enum([...NODE_TYPES, "text"]),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NODE_NAME_LEN)
      .describe("What the reader sees on the node"),
    // The address save_image takes, so a picture found on the web and told
    // to be saved first can always be.
    material: readerUrlSchema
      .optional()
      .describe(
        `role source only: the address of material in the user's storage -- a file uploaded in the chat, ` +
          `or a picture saved with ${SAVE_IMAGE}. Leave it out for an empty node`,
      ),
    template: z
      .union([
        z.object({ id: z.string().min(1), key: z.string().min(1).optional() }).strict(),
        z.object({ id: z.string().min(1), input: z.string().min(1) }).strict(),
      ])
      .optional()
      .describe(
        "This node is part of a template: { id } on the node the template is anchored on, " +
          "{ id, key } on each of its other nodes, { id, input } on a node you give for one of its inputs. " +
          "It fills the mode and model you leave out, and its params while you keep its mode and model; " +
          "what you write wins. A generate node's prompt is yours to send, rewritten from the template's",
      ),
    mode: z.string().min(1).optional().describe("role generate only"),
    model: z.string().min(1).optional().describe("role generate only"),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "role generate only. Each value has to be one its control offers. " +
          "Leave out what a wired node, the vendor's list or the panel's own " +
          "box fills",
      ),
    prompt: z
      .array(promptSegment)
      .optional()
      .describe(
        "What to generate, or a written node's words, in the language the reader " +
          "writes in. Write it up from what the reader asked for; copy their words exactly only when they ask for that. " +
          "A ref or a mark is a segment of its own, never typed into a text segment. " +
          "Every node going into the pool gets a ref where the prompt, or in multi_shot a shot, speaks of it, and a note too " +
          "when it lands empty; a node going into a slot by an edge takes a note of its own (a slot " +
          "filled through fills takes none, the lyrics box takes none), and so does " +
          "an empty node no edge sends into a generation (unwired, or wired only as a link to a model that " +
          "takes nothing from it), for the reader to pick into a slot",
      ),
    shots: z
      .array(
        z
          .object({
            prompt: z.array(promptSegment),
            duration: z.number().int().min(1),
          })
          .strict(),
      )
      .min(1)
      .optional()
      .describe(
        "role generate only, in mode multi_shot and nowhere else: each " +
          "shot's own prompt and whole seconds, which add up to the duration. " +
          "The main prompt is not sent then, so leave it out; refs and notes go in a shot too",
      ),
    // Last on purpose. While this sat before mode and model the default model
    // never wrote it: asked to copy an input holding it character for
    // character, it wrote params, prompt and shots in its place, and 62
    // proposals over two real runs that reasoned about filling a slot carried
    // none. Listed last, the same copy came back whole (inner#1315).
    fills: z
      .record(z.string(), z.array(z.number().int()).min(1))
      .optional()
      .describe(
        "role generate only: slots of this model filled straight from nodes holding material, as slot " +
          "name to their indices. No edge and no note for these; the reference pool is never filled here",
      ),
  })
  .strict();

/**
 * What the tool accepts before any of the checks below run.
 *
 * Exported for the test that pins it: what the schema turns away never
 * reaches `checkProposal`, so the two halves of "a proposal the reader can
 * press" are held by one file and read by one test.
 */
export const inputSchema = z
  .object({
    nodes: z
      .array(proposalNode)
      .min(1)
      .describe("The nodes to place"),
    edges: z
      .array(
        z
          .object({
            fromIndex: z.number().int(),
            toIndex: z.number().int(),
            into: z
              .string()
              .min(1)
              .optional()
              .describe(
                "Where the node wired in goes: \"pool\" (a ref each where the prompt or a shot @s it), " +
                  "the name of a slot the model has (an empty node the reader picks in the panel; a note each; " +
                  "material fills a slot through fills instead), " +
                  `or "${PANEL_EDITOR_PARAM}" for words @'d into a song model's lyrics box for the reader. Needed ` +
                  "when the model takes that kind more than one way",
              ),
          })
          .strict(),
      )
      .describe("Wiring inside this group; indices point into nodes"),
    modelNote: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("What this model is for, in a few words; say nothing about credits or run time"),
    rationale: z.string().trim().min(1).describe("Why this shape, in a sentence or two"),
    groupName: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NODE_NAME_LEN)
      .optional()
      .describe("What the group is for; needed once there are two nodes"),
  })
  .strict();
