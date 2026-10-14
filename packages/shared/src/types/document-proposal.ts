// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The shape of a proposed edit to a document Space (inner#1509).
 *
 * The tool answers with one; the card in the chat column draws it, and the
 * document lands it when the reader presses a button. Three readers, so the
 * shape lives here; a proposal read back from storage is checked against it,
 * so one stored before the shape changed shows as out of date.
 */

import { z } from "zod";

/**
 * A whole proposal. `blockId` is the block a comment or rewrite targets, and
 * the block an insert goes after (`null`: the end of the document). `original`
 * is that block's plain text when the proposal was made, which the landing
 * compares against to tell the reader the block has changed since.
 */
export const documentProposalSchema = z
  .object({
    proposalId: z.string().uuid(),
    spaceId: z.string().uuid(),
    spaceName: z.string(),
    kind: z.enum(["comment", "rewrite", "insert"]),
    blockId: z.string().min(1).nullable(),
    /** The words in the block a comment hangs on, as plain text. */
    quote: z.string().min(1).optional(),
    /** The comment's words, or the Markdown a rewrite or insert lands. */
    body: z.string().min(1),
    title: z.string(),
    /** The nearest heading above the block, empty when there is none. */
    heading: z.string(),
    original: z.string(),
    /** Whether the block holds something a Markdown rewrite replaces. */
    lossy: z.boolean(),
  })
  .refine((p) => (p.kind === "comment") === (p.quote !== undefined), {
    message: "a comment carries a quote and nothing else does",
    path: ["quote"],
  })
  .refine((p) => p.kind === "insert" || p.blockId !== null, {
    message: "a comment or rewrite names its block",
    path: ["blockId"],
  });

/** A whole proposal, as {@link documentProposalSchema} describes it. */
export type DocumentProposal = z.infer<typeof documentProposalSchema>;
