// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each external-agent document command does to a document Space
 * (breatic#1488 §7, §11), on the body the browser's editor binds and through
 * the same schema.
 *
 * The body is read with y-prosemirror's `initProseMirrorDoc` and written back
 * with `updateYFragment` and the metadata that read returned: that metadata is
 * what keeps an element this build's schema does not know, and its attributes,
 * where it was (the patched binding reads such an element as a stand-in and
 * maps the stand-in back to it). Blocks become nodes through BlockNote's
 * `blockToNode` and are read back through `nodeToBlock`.
 *
 * Comments go into the thread map the comment panel reads, in the layout
 * BlockNote's `YjsThreadStore` writes, and the comment mark carries the
 * thread's id on the words, as web's `document-comment-post.ts` does.
 */

import * as Y from "yjs";
import type { LastView } from "@collab/services/last-view-cache.js";
import { documentPeople } from "@collab/services/agent-commands/people.js";
import { readThreadState } from "@breatic/shared/space-content";
import { initProseMirrorDoc, updateYFragment } from "y-prosemirror";
import { blockToNode, nodeToBlock, type PartialBlock } from "@blocknote/core";
import { CommentMark, DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { YjsThreadStore } from "@blocknote/core/yjs";
import type { Mark, Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import {
  callScopedId,
  documentBodyFragment,
  documentCommentThreads,
  type AgentCommand,
  type AgentCommandParams,
  type AgentCommandRefusal,
} from "@breatic/shared";
import { UNSUPPORTED_BLOCK, appendThreadComment, documentPmSchema, startCommentThread } from "@breatic/shared/document-model";
import type { Answer, Json } from "@collab/services/agent-commands/commands.js";

/** The node type of one block, wrapping its content and any nested blocks. */
const BLOCK_CONTAINER = "blockContainer";

/** A document body, read for one command. */
interface Body {
  /** The body as ProseMirror reads it. */
  doc: Node;
  /** What the read mapped, which the write-back needs. */
  meta: ReturnType<typeof initProseMirrorDoc>["meta"];
  /** The fragment it was read from. */
  fragment: Y.XmlFragment;
}

/** One block found in the body. */
interface FoundBlock {
  /** The block container. */
  node: Node;
  /** Where it starts. */
  pos: number;
}

/** The words of one block, and where each character sits in the body. */
interface BlockText {
  /** The plain text: text runs only, textblocks one per line. */
  text: string;
  /** The body position of each character; null for a line break between textblocks. */
  at: Array<number | null>;
}

/**
 * Refuse a command.
 * @param reason - Why.
 * @returns The answer.
 */
function refuse(reason: AgentCommandRefusal): Answer {
  return { status: "rejected", reason };
}

/**
 * Answer a command as done.
 * @param result - What it did.
 * @returns The answer.
 */
function done(result: Json): Answer {
  return { status: "done", result };
}

/**
 * Read the body.
 * @param ydoc - The document Space's document.
 * @returns The body.
 */
function readBody(ydoc: Y.Doc): Body {
  const fragment = documentBodyFragment(ydoc);
  const { doc, meta } = initProseMirrorDoc(fragment, documentPmSchema());
  return { doc, meta, fragment };
}

/**
 * Write a changed body back onto the fragment it was read from.
 * @param ydoc - The document Space's document.
 * @param body - The body as read.
 * @param next - The changed ProseMirror document.
 */
function writeBody(ydoc: Y.Doc, body: Body, next: Node): void {
  updateYFragment(ydoc, body.fragment, next, body.meta);
}

/**
 * Find a block by id, at any depth.
 * @param doc - The body.
 * @param blockId - The block.
 * @returns The block, or undefined when the body does not hold it.
 */
function findBlock(doc: Node, blockId: string): FoundBlock | undefined {
  let found: FoundBlock | undefined;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === BLOCK_CONTAINER && node.attrs.id === blockId) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * The words of a block's own content, without its nested blocks.
 * @param block - The block.
 * @returns Its text and where each character sits.
 */
function blockText(block: FoundBlock): BlockText {
  const content = block.node.firstChild;
  const out: BlockText = { text: "", at: [] };
  if (!content || content.type.name === "blockGroup") return out;
  const start = block.pos + 2;
  let lines = 0;
  content.descendants((node, pos) => {
    if (node.isTextblock && lines++ > 0) {
      out.text += "\n";
      out.at.push(null);
    }
    if (!node.isText) return true;
    for (let i = 0; i < node.text!.length; i++) out.at.push(start + pos + i);
    out.text += node.text;
    return false;
  });
  return out;
}

/**
 * Where some words sit in a block: the one place they occur.
 * @param text - The block's words.
 * @param find - The words to find.
 * @returns The body range, or why there is no single one.
 */
function locate(text: BlockText, find: string): { from: number; to: number } | "not_found" | "ambiguous_text" {
  const first = text.text.indexOf(find);
  if (first === -1) return "not_found";
  if (text.text.indexOf(find, first + 1) !== -1) return "ambiguous_text";
  const at = text.at.slice(first, first + find.length);
  // Words across two lines of a table or a list item are not one run of text.
  if (at.some((pos) => pos === null)) return "not_found";
  return { from: at[0]!, to: at.at(-1)! + 1 };
}

/**
 * The ranges a block's whole text covers, one per run of text.
 * @param text - The block's words.
 * @returns The ranges.
 */
function wholeRanges(text: BlockText): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const pos of text.at) {
    if (pos === null) continue;
    const last = ranges.at(-1);
    if (last && last.to === pos) last.to = pos + 1;
    else ranges.push({ from: pos, to: pos + 1 });
  }
  return ranges;
}

/**
 * The ids an insert command's blocks take, depth first.
 * @param command - The command.
 * @param blocks - The blocks.
 * @returns The blocks with their ids, and every id in order.
 */
function withIds(command: AgentCommand, blocks: ReadonlyArray<Record<string, unknown>>): { blocks: PartialBlock[]; ids: string[] } {
  const ids: string[] = [];
  /**
   * One block with its id and its children's.
   * @param block - The block.
   * @returns The block with ids.
   */
  const stamp = (block: Record<string, unknown>): PartialBlock => {
    const id = callScopedId(command.callId, `block:${String(ids.length)}`);
    ids.push(id);
    const children = Array.isArray(block.children) ? (block.children as Array<Record<string, unknown>>).map(stamp) : undefined;
    return { ...block, id, ...(children ? { children } : {}) };
  };
  return { blocks: blocks.map(stamp), ids };
}

/**
 * The plain text of a comment body, a BlockNote document.
 * @param body - The body.
 * @returns Its words, paragraphs one per line.
 */
function commentText(body: unknown): string {
  if (!Array.isArray(body)) return "";
  return body
    .map((block: { content?: unknown }) =>
      Array.isArray(block.content) ? block.content.map((run: { text?: unknown }) => (typeof run.text === "string" ? run.text : "")).join("") : "",
    )
    .join("\n");
}

/**
 * The words each thread's mark is on, in body order, with the block they are in.
 * @param doc - The document body.
 * @returns By thread id.
 */
function quotedWords(doc: Node): Map<string, { blockId: string; text: string }> {
  const quoted = new Map<string, { blockId: string; text: string }>();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== CommentMark.name || typeof mark.attrs.threadId !== "string") continue;
      const $pos = doc.resolve(pos);
      let blockId = "";
      for (let depth = $pos.depth; depth > 0; depth--) {
        if ($pos.node(depth).type.name === BLOCK_CONTAINER) {
          blockId = String($pos.node(depth).attrs.id);
          break;
        }
      }
      const entry = quoted.get(mark.attrs.threadId);
      if (entry) entry.text += node.text;
      else quoted.set(mark.attrs.threadId, { blockId, text: node.text! });
    }
    return false;
  });
  return quoted;
}

/**
 * Which of the asked document threads are still open, each with its author
 * and the block and words it is on (§11.7): the server's records say which
 * wait for the agent, and a thread whose words were deleted or that was
 * resolved is not one to work on.
 * @param ydoc - The document Space's document.
 * @param threadIds - The threads to look for.
 * @returns The answer.
 */
export function readDocumentAssignments(ydoc: Y.Doc, threadIds: readonly string[]): Answer {
  const quoted = quotedWords(readBody(ydoc).doc);
  const threads = threadIds.flatMap((threadId) => {
    if (readThreadState("document", ydoc, threadId) !== "open") return [];
    // Collaborative data: read as untrusted.
    const first = ((documentCommentThreads(ydoc).get(threadId) as Y.Map<unknown>).get("comments") as Y.Array<unknown> | undefined)?.get(0);
    const authorId = first instanceof Y.Map ? first.get("userId") : (first as { userId?: unknown } | undefined)?.userId;
    return [{
      threadId,
      authorId: typeof authorId === "string" ? authorId : null,
      blockId: quoted.get(threadId)?.blockId ?? null,
      quotedText: quoted.get(threadId)?.text ?? null,
    }];
  });
  return done({ threads });
}

/**
 * Read the document: each top-level block with its id, type, plain text and
 * block JSON, each comment thread with the words it is on, and who is in
 * the document with the words they select.
 * @param ydoc - The document Space's document.
 * @param command - The command.
 * @param views - Every live member view in the Project.
 * @returns The answer.
 */
export function readDocument(ydoc: Y.Doc, command: AgentCommand, views: readonly LastView[]): Answer {
  const { doc } = readBody(ydoc);
  const blocks: Array<Record<string, unknown>> = [];
  const group = doc.firstChild;
  group?.forEach((node, offset) => {
    if (node.type.name !== BLOCK_CONTAINER) return;
    const found = { node, pos: 1 + offset };
    const id = String(node.attrs.id);
    const text = blockText(found);
    const type = node.firstChild?.type.name;
    blocks.push({
      id,
      type: type ?? "",
      text: text.text,
      block: nodeToBlock(node, doc),
      ...(type === UNSUPPORTED_BLOCK ? { unsupported: true } : {}),
    });
  });
  const quoted = quotedWords(doc);
  const store = new YjsThreadStore(command.userId, documentCommentThreads(ydoc), new DefaultThreadStoreAuth(command.userId, "comment"));
  const threads = [...store.getThreads().values()].map((thread) => ({
    threadId: thread.id,
    blockId: quoted.get(thread.id)?.blockId ?? null,
    quotedText: quoted.get(thread.id)?.text ?? null,
    resolved: thread.resolved,
    comments: thread.comments
      .filter((comment) => comment.deletedAt === undefined)
      .map((comment) => {
        const metadata = (comment.metadata ?? {}) as { via?: unknown };
        return {
          id: comment.id,
          userId: comment.userId,
          text: commentText(comment.body),
          ...(typeof metadata.via === "string" ? { via: metadata.via } : {}),
        };
      }),
  }));
  // The block JSON holds no value JSON cannot carry except `undefined`,
  // which the round trip drops.
  return done(JSON.parse(JSON.stringify({ blocks, threads, people: documentPeople(ydoc, views, command) })) as Json);
}

/**
 * Insert blocks after a block, or at the end of the body. A block BlockNote
 * cannot build under this schema refuses the whole batch.
 * @param ydoc - The document Space's document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The answer.
 */
export function insertBlocks(ydoc: Y.Doc, params: AgentCommandParams<"insert_document_blocks">, command: AgentCommand): Answer {
  const body = readBody(ydoc);
  const { blocks, ids } = withIds(command, params.blocks);
  // Written by an earlier delivery of this call.
  if (ids.every((id) => findBlock(body.doc, id))) return done({ blockIds: ids });
  let at: number;
  if (params.afterBlockId) {
    const after = findBlock(body.doc, params.afterBlockId);
    if (!after) return refuse("not_found");
    at = after.pos + after.node.nodeSize;
  } else {
    at = 1 + (body.doc.firstChild?.content.size ?? 0);
  }
  let nodes: Node[];
  try {
    const schema = documentPmSchema();
    nodes = blocks.map((block) => blockToNode(block, schema));
  } catch {
    return refuse("invalid_command");
  }
  const tr = new Transform(body.doc).insert(at, nodes);
  writeBody(ydoc, body, tr.doc);
  return done({ blockIds: ids });
}

/**
 * An insert command's answer once its deadline has passed: done when an
 * earlier delivery wrote its blocks.
 * @param ydoc - The document Space's document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The answer.
 */
export function insertLate(ydoc: Y.Doc, params: AgentCommandParams<"insert_document_blocks">, command: AgentCommand): Answer {
  const { doc } = readBody(ydoc);
  const { ids } = withIds(command, params.blocks);
  return ids.every((id) => findBlock(doc, id)) ? done({ blockIds: ids }) : { status: "unfinished" };
}

/**
 * Replace the one place some words occur in a block. The replacement keeps
 * every mark the whole matched range carries, comments included; nothing
 * outside the range changes.
 * @param ydoc - The document Space's document.
 * @param params - The command's parameters.
 * @returns The answer.
 */
export function editText(ydoc: Y.Doc, params: AgentCommandParams<"edit_document_text">): Answer {
  const body = readBody(ydoc);
  const block = findBlock(body.doc, params.blockId);
  if (!block) return refuse("not_found");
  const range = locate(blockText(block), params.find);
  if (typeof range === "string") return refuse(range);
  let common: readonly Mark[] | null = null;
  body.doc.nodesBetween(range.from, range.to, (node) => {
    if (!node.isText) return true;
    common = common === null ? node.marks : common.filter((mark) => mark.isInSet(node.marks));
    return false;
  });
  const tr = new Transform(body.doc);
  if (params.replace === "") tr.delete(range.from, range.to);
  else tr.replaceWith(range.from, range.to, body.doc.type.schema.text(params.replace, common ?? []));
  writeBody(ydoc, body, tr.doc);
  return done({ blockId: params.blockId });
}

/**
 * Delete blocks, each with any blocks nested in it; any id the body does not
 * hold deletes none of them.
 * @param ydoc - The document Space's document.
 * @param blockIds - The blocks.
 * @returns The answer.
 */
export function deleteBlocks(ydoc: Y.Doc, blockIds: string[]): Answer {
  const body = readBody(ydoc);
  const found = blockIds.map((id) => findBlock(body.doc, id));
  if (found.some((block) => block === undefined)) return refuse("not_found");
  const tr = new Transform(body.doc);
  // Last first, so the earlier positions still hold.
  for (const block of [...(found as FoundBlock[])].sort((a, b) => b.pos - a.pos)) {
    const from = tr.mapping.map(block.pos);
    tr.delete(from, from + block.node.nodeSize);
  }
  writeBody(ydoc, body, tr.doc);
  return done({ blockIds });
}

/**
 * Start a thread on words in a block (or its whole text), or reply to a
 * thread, as the user. Every comment records the connection that wrote it.
 * @param ydoc - The document Space's document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The answer.
 */
export function commentOnDocument(ydoc: Y.Doc, params: AgentCommandParams<"comment_on_document">, command: AgentCommand): Answer {
  const threads = documentCommentThreads(ydoc);
  const commentId = callScopedId(command.callId, "comment");
  if (params.threadId !== undefined) {
    const thread = threads.get(params.threadId);
    if (!(thread instanceof Y.Map)) return refuse("not_found");
    const comments = thread.get("comments");
    if (!(comments instanceof Y.Array)) return refuse("invalid_command");
    if (!comments.toArray().some((c: unknown) => c instanceof Y.Map && c.get("id") === commentId)) {
      appendThreadComment(comments as Y.Array<Y.Map<unknown>>, commentId, command.userId, params.text, { via: command.connectionId });
      thread.set("updatedAt", Date.now());
    }
    // Whether it answered a hand-over is settled once the reply is stored (`answerReply`).
    return done({ threadId: params.threadId, commentId, answered: false });
  }

  const threadId = callScopedId(command.callId, "thread");
  if (threads.has(threadId)) return done({ threadId, commentId, answered: false });
  const body = readBody(ydoc);
  const block = findBlock(body.doc, params.blockId!);
  if (!block) return refuse("not_found");
  const text = blockText(block);
  let ranges: Array<{ from: number; to: number }>;
  if (params.find === undefined) {
    ranges = wholeRanges(text);
  } else {
    const range = locate(text, params.find);
    if (range === "ambiguous_text") return refuse(range);
    ranges = range === "not_found" ? [] : [range];
  }
  if (ranges.length === 0) return refuse("not_found");
  appendThreadComment(startCommentThread(threads, threadId), commentId, command.userId, params.text, { via: command.connectionId });
  const mark = body.doc.type.schema.marks[CommentMark.name]!.create({ threadId, orphan: false });
  const tr = new Transform(body.doc);
  for (const { from, to } of ranges) tr.addMark(from, to, mark);
  writeBody(ydoc, body, tr.doc);
  return done({ threadId, commentId, answered: false });
}
