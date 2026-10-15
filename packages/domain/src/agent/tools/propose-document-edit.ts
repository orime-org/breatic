// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Propose a comment, a rewrite or an insert for the open document
 * (inner#1509).
 *
 * The target is the document Space the reader has open this turn, read from
 * the blocks their browser sent with the message: each top-level block
 * behind a `<!-- b:N -->` marker in what the model reads, and its plain text
 * beside it. The tool checks a proposal against those blocks and answers
 * with what the card draws; nothing lands until the reader presses a button
 * on the card. A refusal says what is wrong, the rule it breaks and the facts
 * the agent needs, and the agent puts the proposal right from that.
 */

import { randomUUID } from "node:crypto";

import { tool, type Tool } from "ai";
import { z } from "zod";

import { hasWords, occurrences, type ChatDocumentBlock, type DocumentProposal, type ProposalRefused } from "@breatic/shared";

/** The document a proposal goes to: the one the reader has open this turn. */
export interface OpenDocument {
  spaceId: string;
  spaceName: string;
  blocks: ChatDocumentBlock[];
}

/** What the tool answers with: the proposal, or why it was refused. */
export type DocumentProposalAnswer = (DocumentProposal & { placed: true }) | ProposalRefused;

export const documentEditInputSchema = z
  .object({
    kind: z
      .enum(["comment", "rewrite", "insert"])
      .describe("comment: a remark on words in a block. rewrite: replace a whole block. insert: add new content."),
    block: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The N of the block's <!-- b:N --> marker. A comment or a rewrite targets it; an insert goes after it, or at the end of the document when left out.",
      ),
    quote: z
      .string()
      .min(1)
      .optional()
      .describe(
        "For a comment only: the words in that block it hangs on, appearing there once. Written without Markdown " +
          "(no **, *, ~~, backticks, and a link as its words only); paragraphs and table cells one per line.",
      ),
    body: z
      .string()
      .describe("A comment's words, or the Markdown a rewrite puts in the block's place or an insert adds."),
    title: z.string().describe("The card's title: one short line saying what the proposal does."),
  })
  .strict();

type DocumentEditInput = z.infer<typeof documentEditInputSchema>;

/**
 * A refusal.
 * @param reason - What is wrong, the rule and the facts.
 * @returns The answer.
 * @throws {never} Never.
 */
function refused(reason: string): ProposalRefused {
  return { placed: false, reason };
}

/**
 * The nearest heading at or above a block.
 * @param blocks - The document's blocks.
 * @param index - Where to start looking, counting down.
 * @returns The heading's text, or empty when there is none.
 * @throws {never} Never.
 */
function headingAbove(blocks: readonly ChatDocumentBlock[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const candidate = blocks[i];
    if (candidate?.type === "heading") return candidate.text;
  }
  return "";
}

/**
 * Why a comment's quote does not hold in its block, or null when it does.
 * @param quote - The words the agent quoted.
 * @param n - The block's number.
 * @param text - The block's plain text.
 * @returns The reason, or null.
 * @throws {never} Never.
 */
function quoteProblem(quote: string, n: number, text: string): string | null {
  if (!hasWords(quote)) {
    return "A comment hangs on words, and line breaks alone mark none; quote words from the block, or propose a rewrite or an insert.";
  }
  const times = occurrences(text, quote);
  if (times === 1) return null;
  if (times > 1) {
    return `The quote appears ${String(times)} times in block ${String(n)}; quote enough of the words around it that it appears once.`;
  }
  return (
    `The quote is not in block ${String(n)}. A quote is matched against the block's words without Markdown -- ` +
    "no **, *, ~~ or backticks, a link as its words only -- with paragraphs and table cells one per line. " +
    `Block ${String(n)} reads: ${JSON.stringify(text)}`
  );
}

/**
 * Why the block a proposal names does not hold, or null when it does.
 * @param input - What the agent sent.
 * @param blocks - The open document's blocks.
 * @returns The reason, or null.
 * @throws {never} Never.
 */
function blockProblem(input: DocumentEditInput, blocks: readonly ChatDocumentBlock[]): string | null {
  if (input.block === undefined) {
    return input.kind === "insert" ? null : `A ${input.kind} names the block it targets by its <!-- b:N --> number.`;
  }
  const target = blocks[input.block - 1];
  if (target === undefined) {
    return `There is no block ${String(input.block)} among the blocks sent: they run from 1 to ${String(blocks.length)}.`;
  }
  return target.partial
    ? `Block ${String(input.block)} was cut at the limit, so its whole text was not sent and it cannot be proposed on.`
    : null;
}

/**
 * The answer for one proposal: checked against the open document's blocks,
 * and filled in with what the card and the landing read.
 * @param input - What the agent sent.
 * @param open - The document the reader has open, or null when none can be read.
 * @param proposalId - The id this proposal is known by from here on.
 * @returns The proposal, or why it was refused.
 * @throws {never} Never.
 */
export function answerDocumentEdit(
  input: DocumentEditInput,
  open: OpenDocument | null,
  proposalId: string,
): DocumentProposalAnswer {
  if (open === null) {
    return refused("The reader has no document open that this message could read, so there is no block to propose on.");
  }
  const problem = blockProblem(input, open.blocks);
  if (problem !== null) return refused(problem);
  if (input.kind === "comment" && input.quote === undefined) {
    return refused("A comment carries a quote: the words in its block it hangs on.");
  }
  if (input.kind !== "comment" && input.quote !== undefined) {
    return refused(`Only a comment carries a quote; a ${input.kind} does not.`);
  }
  if (input.body.trim() === "") return refused("The body holds nothing.");
  const index = input.block === undefined ? open.blocks.length - 1 : input.block - 1;
  const target = input.block === undefined ? undefined : open.blocks[index];
  if (input.quote !== undefined && target !== undefined) {
    const wrong = quoteProblem(input.quote, index + 1, target.text);
    if (wrong !== null) return refused(wrong);
  }
  return {
    placed: true,
    proposalId,
    spaceId: open.spaceId,
    spaceName: open.spaceName,
    kind: input.kind,
    blockId: target?.id ?? null,
    ...(input.quote === undefined ? {} : { quote: input.quote }),
    body: input.body,
    title: input.title,
    heading: headingAbove(open.blocks, index),
    original: target?.text ?? "",
    blockType: target?.type ?? null,
    lossy: input.kind === "rewrite" && target !== undefined ? target.lossy : false,
  };
}

/**
 * The one line the model reads back. The proposal is for the reader; the
 * model sent it, and repeating it into every later turn costs it again.
 * @param answer - What the tool answered.
 * @returns A sentence saying it is on screen, or why it is not.
 * @throws {never} Never.
 */
export function renderDocumentProposalForModel(answer: DocumentProposalAnswer): string {
  return answer.placed
    ? "The proposal is on screen as a card. The reader decides whether to apply it."
    : `That proposal was refused, so nothing is on screen. ${answer.reason}`;
}

/** What this tool is handed in its context: the document the reader has open. */
export interface ProposeDocumentContext extends Record<string, unknown> {
  openDocument: OpenDocument | null;
}

const blockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  text: z.string(),
  lossy: z.boolean(),
  partial: z.boolean(),
});

const proposeDocumentContextSchema: z.ZodType<ProposeDocumentContext> = z.object({
  openDocument: z.object({ spaceId: z.string(), spaceName: z.string(), blocks: z.array(blockSchema) }).nullable(),
});

/**
 * The document proposal tool.
 * @returns The tool.
 * @throws {never} Never.
 */
export function makeProposeDocumentEdit(): Tool<DocumentEditInput, DocumentProposalAnswer, ProposeDocumentContext> {
  return tool({
    description:
      "Propose a comment on, a rewrite of, or an insert into the document the reader has open, as a card they " +
      "apply with one press. It works on the document under \"The Space the reader has open\" in the message, " +
      "where each top-level block follows a <!-- b:N --> marker: name a block by that N. A comment hangs on " +
      "words in one block and the reader can reply to it or resolve it; a rewrite replaces one whole block with " +
      "your Markdown; an insert adds Markdown -- paragraphs, headings (#, ## and ### only: the document has three " +
      "levels, and deeper ones land as ###), lists, a table -- after a block or at the " +
      "end. Nothing changes in the document until the reader presses the card. One proposal per change: several " +
      "changes are several calls, and content that follows one place -- a run of paragraphs, several scenes -- " +
      "goes in one insert, in the order it reads. An image, video or audio in the Markdown lands only when its " +
      "address is in our storage (a file uploaded or saved here); an outside link is left out.",
    inputSchema: documentEditInputSchema,
    contextSchema: proposeDocumentContextSchema,
    metadata: { runningLine: "chat.tool.proposingDocumentEdit" },
    toModelOutput: ({ output }) => ({ type: "text", value: renderDocumentProposalForModel(output) }),
    execute: (
      input: DocumentEditInput,
      // The signal is unused: the check reads only what the context holds.
      // Declared so every tool has the same shape.
      { context }: { abortSignal?: AbortSignal; context: ProposeDocumentContext },
    ): Promise<DocumentProposalAnswer> => Promise.resolve(answerDocumentEdit(input, context.openDocument, randomUUID())),
  });
}
