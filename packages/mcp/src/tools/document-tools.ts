// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tools that read and change a document Space (breatic#1488 §11): the
 * agent reads and writes Markdown, collab reads and writes the body's blocks.
 * A medium inserted from outside our storage is brought into it in the same
 * call, as a paste brings it in.
 */

import { z } from "zod";
import { blockToMarkdown, markdownToBlocks, notInMarkdown, settleMedia, type DocumentBlock, type MediaDecision } from "@mcp/tools/markdown.js";
import { namesIn } from "@mcp/tools/names.js";
import { defineTool, outcomeValue, runCommand, ToolRefusal, type ToolDeps } from "@mcp/tools/kit.js";

const projectId = z.uuid().describe("The Project's id.");
const spaceId = z.uuid().describe("The document Space's id.");
const blockId = z.string().min(1).describe("A block's id, as read_document gives it.");

/** One block as collab reads it. */
interface ReadBlock {
  id: string;
  type: string;
  text: string;
  block: DocumentBlock;
  unsupported?: true;
}

/** A thread as collab reads it. */
interface ReadThread {
  blockId: string | null;
}

export const readDocument = defineTool({
  name: "read_document",
  description:
    "Read a document Space: each top-level block with its id, type, its Markdown (children included) and its plain text (the text edit_document_text matches against), " +
    "and notInMarkdown listing what the block carries that Markdown cannot (text color, background color, underline, alignment, comments): rewrite such a block with edit_document_text, which keeps them. " +
    "A block of a kind this service does not know is marked unsupported; leave it as it is. Also the comment threads (the words each is on, its comments, who wrote them, which agent wrote one (via)), " +
    "and the people in the document now with the block their caret is in and the words they selected. `names` gives each member's and agent's name by id.",
  input: z.object({ projectId, spaceId }),
  readOnly: true,
  run: async (deps, args) => {
    const outcome = await runCommand(deps, { type: "read_document", projectId: args.projectId, spaceId: args.spaceId, params: {} });
    if (outcome.kind === "pending") return { value: outcomeValue(outcome) };
    const result = outcome.result as { blocks: ReadBlock[]; threads: ReadThread[]; people: unknown[] };
    const commented = new Set(result.threads.map((thread) => thread.blockId));
    const blocks = await Promise.all(
      result.blocks.map(async (read) => ({
        id: read.id,
        type: read.type,
        markdown: (await blockToMarkdown(read.block)).trim(),
        text: read.text,
        notInMarkdown: notInMarkdown(read.block, commented.has(read.id)),
        ...(read.unsupported ? { unsupported: true } : {}),
      })),
    );
    const { threads, people } = result;
    return { value: { blocks, threads, people, names: await namesIn(deps.api, { threads, people }) } };
  },
});

/** What the upload routes tell the browser. */
interface UploadConfig {
  assetUrlPrefix: string;
  uploadStatusPollSeconds: number;
}

/** One upload's state, as `GET /assets/upload-status` answers it. */
interface UploadStatusItem {
  key: string;
  state: "finishing" | "completed" | "transferred" | "failed" | "unknown";
  result?: { fileUrl: string; width: number | null; height: number | null };
}

/**
 * Where media inserted into a document land: ours stays, an outside address
 * is fetched into storage by the ingest Worker and lands at its stored
 * address, anything else (or a fetch that fails or outlasts the call) is left out.
 * @param deps - The call.
 * @param project - The Project.
 * @param space - The document Space.
 * @returns The decision for each medium.
 */
function mediaDecision(deps: ToolDeps, project: string, space: string): MediaDecision {
  let config: Promise<UploadConfig> | undefined;
  return async (url) => {
    config ??= deps.api.get<UploadConfig>("/assets/upload-config");
    const { assetUrlPrefix, uploadStatusPollSeconds } = await config;
    if (url.startsWith(assetUrlPrefix)) return { url, width: 0, height: 0 };
    if (!/^https?:\/\//i.test(url)) return null;
    try {
      const { storage_key: key } = await deps.api.post<{ storage_key: string }>("/assets/ingest-url", { url, project_id: project, space_id: space });
      const deadline = deps.call.startedAt + deps.config.call_timeout_ms - deps.config.command_wait_ms;
      while (Date.now() < deadline) {
        const { items } = await deps.api.get<{ items: UploadStatusItem[] }>("/assets/upload-status", { key });
        const status = items.find((item) => item.key === key);
        if (status?.state === "completed" && status.result) return { url: status.result.fileUrl, width: status.result.width ?? 0, height: status.result.height ?? 0 };
        if (status?.state !== "finishing") return null;
        await new Promise((resolve) => setTimeout(resolve, uploadStatusPollSeconds * 1000));
      }
      return null;
    } catch (err) {
      deps.report(err instanceof Error ? err : new Error(String(err)), { operation: "document_media_ingest", projectId: project });
      return null;
    }
  };
}

export const insertDocumentBlocks = defineTool({
  name: "insert_document_blocks",
  description:
    "Insert Markdown as new blocks after a block (or at the end of the document when afterBlockId is left out), as typing or pasting it does. Headings go to level 3 at most. " +
    "An image from outside our storage is fetched into it first and lands as a normal image; one that cannot be fetched, or an address that is not http(s), is left out and counted in mediaLeftOut. " +
    "To restyle a block, insert its new version and delete the old one: that drops the old block's comments and colors. Returns the new block ids.",
  input: z.object({
    projectId,
    spaceId,
    afterBlockId: blockId.optional(),
    markdown: z.string().describe("The blocks, as Markdown."),
  }),
  readOnly: false,
  run: async (deps, args) => {
    const parsed = await markdownToBlocks(args.markdown);
    if (parsed.length === 0 || args.markdown.trim() === "") throw new ToolRefusal("invalid_request", "The Markdown holds no block to insert.");
    const { blocks, leftOut } = await settleMedia(parsed, mediaDecision(deps, args.projectId, args.spaceId));
    if (blocks.length === 0) return { value: { blockIds: [], mediaLeftOut: leftOut } };
    const outcome = await runCommand(deps, {
      type: "insert_document_blocks",
      projectId: args.projectId,
      spaceId: args.spaceId,
      params: { ...(args.afterBlockId === undefined ? {} : { afterBlockId: args.afterBlockId }), blocks: blocks },
    });
    const value = outcomeValue(outcome);
    return { value: outcome.kind === "done" ? { ...(value as Record<string, unknown>), mediaLeftOut: leftOut } : value };
  },
});

export const editDocumentText = defineTool({
  name: "edit_document_text",
  description:
    "Change words inside one block: find is a passage of the block's plain text (as read_document gives it) and replace the words to put there, plain text. " +
    "The new words keep every mark the old passage had throughout (comments, colors, links, bold); the rest of the block is untouched. " +
    "Refused when the passage is not in the block or appears more than once (quote a longer one), or spans two lines of the block.",
  input: z.object({ projectId, spaceId, blockId, find: z.string().min(1), replace: z.string() }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, ...params }) => ({
    value: outcomeValue(await runCommand(deps, { type: "edit_document_text", projectId: project, spaceId: space, params })),
  }),
});

export const deleteDocumentBlocks = defineTool({
  name: "delete_document_blocks",
  description: "Delete blocks, with their children. If any block named is not in the document, none is deleted.",
  input: z.object({ projectId, spaceId, blockIds: z.array(blockId).min(1) }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, blockIds }) => ({
    value: outcomeValue(await runCommand(deps, { type: "delete_document_blocks", projectId: project, spaceId: space, params: { blockIds } })),
  }),
});

export const commentOnDocument = defineTool({
  name: "comment_on_document",
  description:
    "Comment as the user: start a thread on a block (on the words find names, or on the block's whole text), or reply to a thread (threadId). Name exactly one of blockId and threadId. " +
    "A reply to a thread handed to you answers it: the result says answered: true, and it leaves list_assignments.",
  input: z.object({
    projectId,
    spaceId,
    text: z.string().min(1).describe("The comment."),
    blockId: blockId.optional().describe("Start a thread on this block."),
    find: z.string().min(1).optional().describe("The words in the block the thread is on; once in the block."),
    threadId: z.string().min(1).optional().describe("Reply to this thread."),
  }),
  readOnly: false,
  run: async (deps, { projectId: project, spaceId: space, ...params }) => ({
    value: outcomeValue(await runCommand(deps, { type: "comment_on_document", projectId: project, spaceId: space, params })),
  }),
});

/** The document tools. */
export const DOCUMENT_TOOLS = [readDocument, insertDocumentBlocks, editDocumentText, deleteDocumentBlocks, commentOnDocument];
