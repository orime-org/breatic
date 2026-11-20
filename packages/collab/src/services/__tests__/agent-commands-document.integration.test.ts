// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The document commands an external agent sends (#1488 §7, §11), executed by
 * collab on the document body the browser's editor binds: blocks are read
 * out with their ids and plain text, written back through the same schema so
 * blocks this build does not know survive, edits keep the marks on the words
 * they replace, and comments go into the same thread store the comment panel
 * reads. Writes are refused while the published document format differs from
 * this build's, and while the Space is full only deletions run.
 */

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { sql as dsql } from "drizzle-orm";

import {
  DOCUMENT_SCHEMA_META_KEY,
  callScopedId,
  documentBodyFragment,
  documentCommentThreads,
  documentSpaceDocName,
  projectMetaDocName,
} from "@breatic/shared";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { publishDocumentSchema } from "@collab/services/document-schema-publisher.js";
import { getCollabConfig } from "@collab/config.js";
import { getCollabRedis } from "@breatic/core";
import { recordLastView } from "@collab/services/last-view-cache.js";
import {
  call,
  consumeOn,
  harness,
  replyOf,
  resultOf,
  run,
  seedWorld,
  send,
  useAgentCommandHarness,
  type World,
} from "@collab/services/__tests__/agent-command-harness.js";

useAgentCommandHarness();

/** One block as `read_document` returns it. */
interface ReadBlock {
  id: string;
  type: string;
  text: string;
  block: { type: string; content?: unknown; props?: Record<string, unknown> };
  unsupported?: boolean;
}

/** One thread as `read_document` returns it. */
interface ReadThread {
  threadId: string;
  blockId: string | null;
  quotedText: string | null;
  resolved: boolean;
  comments: Array<{ id: string; userId: string; text: string; via?: string }>;
}

/**
 * A paragraph block the way the editor stores it.
 * @param id - The block id.
 * @param text - Its words.
 * @returns The block container.
 */
function paragraph(id: string, text: string): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);
  const para = new Y.XmlElement("paragraph");
  para.setAttribute("backgroundColor", "default");
  para.setAttribute("textColor", "default");
  para.setAttribute("textAlignment", "left");
  para.setAttribute("quoted", false as never);
  const words = new Y.XmlText();
  words.insert(0, text);
  para.insert(0, [words]);
  container.insert(0, [para]);
  return container;
}

/**
 * A block a newer build wrote, which this build's schema does not know.
 * @param id - The block id.
 * @returns The block container.
 */
function futureBlock(id: string): Y.XmlElement {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);
  const future = new Y.XmlElement("futureBlock");
  future.setAttribute("payload", "kept-by-browser");
  container.insert(0, [future]);
  return container;
}

/**
 * A world whose Project also holds a document Space, published at this
 * build's document format unless told otherwise.
 * @param blocks - The body's blocks, top to bottom.
 * @param options - How to seed it.
 * @param options.role - The user's role on the Project.
 * @param options.staleFormat - Publish a document format other than this build's.
 * @returns The world, aimed at the document Space.
 */
async function seedDocumentWorld(
  blocks: Y.XmlElement[],
  options: { role?: "owner" | "editor" | "viewer"; staleFormat?: boolean } = {},
): Promise<World & { canvasSpaceId: string }> {
  const world = await seedWorld(options.role ?? "owner");
  const documentSpaceId = randomUUID();
  const meta = new Y.Doc();
  const spaces = meta.getMap("spaces");
  for (const [id, type, name, order] of [
    [world.spaceId, "canvas", "Board", 0],
    [documentSpaceId, "document", "Script", 1],
  ] as const) {
    const entry = new Y.Map<unknown>();
    spaces.set(id, entry);
    entry.set("type", type);
    entry.set("name", name);
    entry.set("order", order);
  }
  publishDocumentSchema(meta);
  if (options.staleFormat) {
    const published = meta.getMap(DOCUMENT_SCHEMA_META_KEY);
    published.set("version", "0".repeat(16));
    published.set("publishedAt", "2999-01-01T00:00:00.000Z");
  }
  await yjsRepo.upsertDocData(projectMetaDocName(world.projectId), Y.encodeStateAsUpdate(meta));
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, blocks);
  documentBodyFragment(doc).insert(0, [group]);
  await yjsRepo.upsertDocData(documentSpaceDocName(world.projectId, documentSpaceId), Y.encodeStateAsUpdate(doc));
  return { ...world, canvasSpaceId: world.spaceId, spaceId: documentSpaceId };
}

/**
 * Read the document through the agent's own read command.
 * @param world - Whose document.
 * @returns Its blocks and threads.
 */
async function readDocument(world: World): Promise<{ blocks: ReadBlock[]; threads: ReadThread[] }> {
  const reply = await call(world, "read_document", {});
  if (reply?.status !== "done") throw new Error(`read_document answered ${JSON.stringify(reply)}`);
  return reply.result as unknown as { blocks: ReadBlock[]; threads: ReadThread[] };
}

/**
 * The element names in a document's body as an instance serves it, depth first.
 * @param world - Whose document.
 * @returns The names.
 */
async function bodyElementNames(world: World): Promise<string[]> {
  const conn = await harness.instanceB.openDirectConnection(documentSpaceDocName(world.projectId, world.spaceId), {});
  try {
    const out: string[] = [];
    await conn.transact((doc) => {
      const walk = (el: Y.XmlFragment | Y.XmlElement): void => {
        for (const child of el.toArray()) {
          if (child instanceof Y.XmlElement) {
            out.push(child.nodeName);
            walk(child);
          }
        }
      };
      walk(documentBodyFragment(doc));
    });
    return out;
  } finally {
    await conn.disconnect();
  }
}

describe("read_document", () => {
  it("reads each block's id, type, plain text and block JSON, and marks a block this build does not know", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "First paragraph."), futureBlock("fut"), paragraph("b1", "Second paragraph.")]);
    consumeOn(world, harness.instanceA);
    const { blocks, threads } = await readDocument(world);
    expect(blocks.map((b) => [b.id, b.type, b.text])).toEqual([
      ["b0", "paragraph", "First paragraph."],
      ["fut", "unsupportedBlock", ""],
      ["b1", "paragraph", "Second paragraph."],
    ]);
    expect(blocks[0]!.block).toMatchObject({ type: "paragraph" });
    expect(blocks[1]!.unsupported).toBe(true);
    expect(threads).toEqual([]);
  });

  it("answers not_found when the Space is not a document", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "x")]);
    consumeOn(world, harness.instanceA);
    expect(await call({ ...world, spaceId: world.canvasSpaceId }, "read_document", {})).toMatchObject({ status: "rejected", reason: "not_found" });
  });

  it("lets a viewer read and refuses their writes as read_only", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "x")], { role: "viewer" });
    consumeOn(world, harness.instanceA);
    await readDocument(world);
    expect(await call(world, "delete_document_blocks", { blockIds: ["b0"] })).toMatchObject({ status: "rejected", reason: "read_only" });
  });
});

describe("insert_document_blocks", () => {
  it("inserts blocks after the one named, with ids derived from the call, and keeps a block this build does not know", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "First."), futureBlock("fut"), paragraph("b1", "Last.")]);
    consumeOn(world, harness.instanceA);
    const command = await send(world, "insert_document_blocks", {
      afterBlockId: "b0",
      blocks: [
        { type: "heading", props: { level: 2 }, content: "Scene one" },
        { type: "paragraph", content: [{ type: "text", text: "Bold", styles: { bold: true } }, { type: "text", text: " words.", styles: {} }] },
      ],
    });
    const ids = [callScopedId(command.callId, "block:0"), callScopedId(command.callId, "block:1")];
    expect(await replyOf(world, command.callId)).toMatchObject({ status: "done", result: { blockIds: ids } });
    const { blocks } = await readDocument(world);
    expect(blocks.map((b) => [b.id, b.text])).toEqual([
      ["b0", "First."],
      [ids[0], "Scene one"],
      [ids[1], "Bold words."],
      ["fut", ""],
      ["b1", "Last."],
    ]);
    expect(blocks[1]!.block).toMatchObject({ type: "heading", props: { level: 2 } });
    expect(blocks[2]!.block.content).toEqual([
      expect.objectContaining({ text: "Bold", styles: { bold: true } }),
      expect.objectContaining({ text: " words." }),
    ]);
    expect(await bodyElementNames(world)).toContain("futureBlock");
  });

  it("appends at the end when no block is named", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "First.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "insert_document_blocks", { blocks: [{ type: "paragraph", content: "Appended." }] })).toMatchObject({ status: "done" });
    expect((await readDocument(world)).blocks.map((b) => b.text)).toEqual(["First.", "Appended."]);
  });

  it("inserts a call's blocks once, however many times it is delivered", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "First.")]);
    consumeOn(world, harness.instanceA);
    consumeOn(world, harness.instanceB);
    const command = await send(world, "insert_document_blocks", { blocks: [{ type: "paragraph", content: "Once." }] });
    await replyOf(world, command.callId);
    await harness.mcp.xadd(`${world.prefix}:mcp:commands`, "*", "command", JSON.stringify(command));
    await new Promise((r) => setTimeout(r, 500));
    expect((await readDocument(world)).blocks.map((b) => b.text)).toEqual(["First.", "Once."]);
  });

  it("answers not_found for a block that is not in the document", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "First.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "insert_document_blocks", { afterBlockId: "gone", blocks: [{ type: "paragraph", content: "x" }] })).toMatchObject({
      status: "rejected",
      reason: "not_found",
    });
  });

  it("refuses a block type the document schema does not have as invalid_command", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "First.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "insert_document_blocks", { blocks: [{ type: "noSuchBlock", content: "x" }] })).toMatchObject({
      status: "rejected",
      reason: "invalid_command",
    });
    expect((await readDocument(world)).blocks).toHaveLength(1);
  });
});

describe("edit_document_text", () => {
  it("replaces only the words named and keeps their bold", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "First.")]);
    consumeOn(world, harness.instanceA);
    await call(world, "insert_document_blocks", {
      afterBlockId: "b0",
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "Hello world", styles: { bold: true } }, { type: "text", text: " again.", styles: {} }] }],
    });
    const target = (await readDocument(world)).blocks[1]!;
    expect(await call(world, "edit_document_text", { blockId: target.id, find: "world", replace: "there" })).toMatchObject({ status: "done" });
    const after = (await readDocument(world)).blocks[1]!;
    expect(after.text).toBe("Hello there again.");
    expect(after.block.content).toEqual([
      expect.objectContaining({ text: "Hello there", styles: { bold: true } }),
      expect.objectContaining({ text: " again." }),
    ]);
  });

  it("keeps a comment on the words it replaces", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Hello world, again.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "comment_on_document", { blockId: "b0", find: "world", text: "Which one?" })).toMatchObject({ status: "done" });
    expect(await call(world, "edit_document_text", { blockId: "b0", find: "world", replace: "planet" })).toMatchObject({ status: "done" });
    const { blocks, threads } = await readDocument(world);
    expect(blocks[0]!.text).toBe("Hello planet, again.");
    expect(threads.map((t) => t.quotedText)).toEqual(["planet"]);
  });

  it("answers not_found when the words are not there and ambiguous_text when they are there twice", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "one two one")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "edit_document_text", { blockId: "b0", find: "three", replace: "x" })).toMatchObject({ status: "rejected", reason: "not_found" });
    expect(await call(world, "edit_document_text", { blockId: "b0", find: "one", replace: "x" })).toMatchObject({ status: "rejected", reason: "ambiguous_text" });
    expect((await readDocument(world)).blocks[0]!.text).toBe("one two one");
  });
});

describe("delete_document_blocks", () => {
  it("deletes the blocks named and keeps the rest, a block this build does not know included", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Keep."), futureBlock("fut"), paragraph("b1", "Drop.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "delete_document_blocks", { blockIds: ["b1"] })).toMatchObject({ status: "done" });
    expect((await readDocument(world)).blocks.map((b) => b.id)).toEqual(["b0", "fut"]);
    expect(await bodyElementNames(world)).toContain("futureBlock");
  });

  it("answers not_found for a block that is not there and deletes none of the batch", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Keep."), paragraph("b1", "Also keep.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "delete_document_blocks", { blockIds: ["b1", "gone"] })).toMatchObject({ status: "rejected", reason: "not_found" });
    expect((await readDocument(world)).blocks).toHaveLength(2);
  });
});

describe("comment_on_document", () => {
  it("starts a thread on words in a block, written by the user, in the store the comment panel reads", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Hello world.")]);
    consumeOn(world, harness.instanceA);
    const reply = await call(world, "comment_on_document", { blockId: "b0", find: "world", text: "Which one?" });
    expect(reply).toMatchObject({ status: "done", result: { threadId: expect.any(String), commentId: expect.any(String) } });
    const { threads } = await readDocument(world);
    expect(threads).toEqual([
      expect.objectContaining({
        threadId: resultOf<{ threadId: string }>(reply).threadId,
        blockId: "b0",
        quotedText: "world",
        resolved: false,
        comments: [expect.objectContaining({ userId: world.userId, text: "Which one?", via: world.connectionId })],
      }),
    ]);
  });

  it("starts a thread on a whole block when no words are named", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Hello world.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "comment_on_document", { blockId: "b0", text: "Rewrite this" })).toMatchObject({ status: "done" });
    expect((await readDocument(world)).threads.map((t) => t.quotedText)).toEqual(["Hello world."]);
  });

  it("answers not_found for a reply to a thread that is gone and for words that are not there", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Hello world.")]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "comment_on_document", { threadId: randomUUID(), text: "Done" })).toMatchObject({ status: "rejected", reason: "not_found" });
    expect(await call(world, "comment_on_document", { blockId: "b0", find: "planet", text: "?" })).toMatchObject({ status: "rejected", reason: "not_found" });
  });
});

describe("document limits", () => {
  it("refuses writes while the published document format differs from this build's, and still reads", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Hello.")], { staleFormat: true });
    consumeOn(world, harness.instanceA);
    await readDocument(world);
    expect(await call(world, "insert_document_blocks", { blocks: [{ type: "paragraph", content: "x" }] })).toMatchObject({ status: "rejected", reason: "schema_mismatch" });
    expect(await call(world, "edit_document_text", { blockId: "b0", find: "Hello", replace: "Bye" })).toMatchObject({ status: "rejected", reason: "schema_mismatch" });
  });

  it("refuses everything but deletions on a document past max_document_bytes", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Small."), paragraph("big", "x".repeat(getCollabConfig().max_document_bytes + 1024))]);
    consumeOn(world, harness.instanceA);
    expect(await call(world, "insert_document_blocks", { blocks: [{ type: "paragraph", content: "x" }] })).toMatchObject({ status: "rejected", reason: "space_full" });
    expect(await call(world, "comment_on_document", { blockId: "b0", text: "x" })).toMatchObject({ status: "rejected", reason: "space_full" });
    expect(await call(world, "delete_document_blocks", { blockIds: ["big"] })).toMatchObject({ status: "done" });
  }, 30_000);
});

describe("who is in the document and what they selected (#1488 §11.4)", () => {
  it("turns each member's caret into the block it is in and the words it selects", async () => {
    const first = paragraph("b-1", "Hello brave world");
    const second = paragraph("b-2", "Second line");
    const world = await seedDocumentWorld([first, second]);
    consumeOn(world, harness.instanceA);
    const words = (first.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const other = (second.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const at = (text: Y.XmlText, index: number): Record<string, unknown> =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index)) as Record<string, unknown>;
    const member = randomUUID();
    const view = { activeNodeIds: null, pointer: null, camera: null };
    await recordLastView(getCollabRedis(), world.prefix, { projectId: world.projectId, userId: world.userId, spaceId: world.spaceId, view: { ...view, cursor: { anchor: at(words, 6), head: at(words, 11) } } }, 60_000, Date.now());
    await recordLastView(getCollabRedis(), world.prefix, { projectId: world.projectId, userId: member, spaceId: world.spaceId, view: { ...view, cursor: { anchor: at(other, 3), head: at(other, 3) } } }, 60_000, Date.now());
    await recordLastView(getCollabRedis(), world.prefix, { projectId: world.projectId, userId: randomUUID(), spaceId: world.canvasSpaceId, view: { ...view, cursor: null } }, 60_000, Date.now());
    const { people } = (await readDocument(world)) as unknown as { people: unknown[] };
    expect(people).toEqual(
      expect.arrayContaining([
        { userId: world.userId, you: true, blockId: "b-1", selectedText: "brave" },
        { userId: member, you: false, blockId: "b-2", selectedText: "" },
      ]),
    );
    expect(people).toHaveLength(2);
  });

  it("lists a member whose caret no longer resolves without a block", async () => {
    const world = await seedDocumentWorld([paragraph("b-1", "Hello")]);
    consumeOn(world, harness.instanceA);
    const gone = { type: null, tname: null, item: { client: 999_999, clock: 5 }, assoc: 0 };
    await recordLastView(getCollabRedis(), world.prefix, { projectId: world.projectId, userId: world.userId, spaceId: world.spaceId, view: { activeNodeIds: null, pointer: null, camera: null, cursor: { anchor: gone, head: gone } } }, 60_000, Date.now());
    const { people } = (await readDocument(world)) as unknown as { people: unknown[] };
    expect(people).toEqual([{ userId: world.userId, you: true, blockId: null, selectedText: null }]);
  });
});

describe("what is handed over in a document (#1488 §11.7)", () => {
  it("says which connection a thread waits for when the document is read", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Hello world.")]);
    consumeOn(world, harness.instanceA);
    const { threadId } = resultOf<{ threadId: string }>(await call(world, "comment_on_document", { blockId: "b0", find: "world", text: "Bigger?" }));
    await run(dsql`INSERT INTO comment_assignments (project_id, space_id, thread_id, connection_id, assigned_by, assigned_at, status)
      VALUES (${world.projectId}, ${world.spaceId}, ${threadId}, ${world.connectionId}, ${world.userId}, 1, 'pending')`);
    const thread = (await readDocument(world)).threads.find((t) => t.threadId === threadId) as ReadThread & { handedTo?: string };
    expect(thread.handedTo).toBe(world.connectionId);
  });

  it("tells which of the asked threads are still open in the document, with the words they are on", async () => {
    const world = await seedDocumentWorld([paragraph("b0", "Hello world."), paragraph("b1", "Second.")]);
    consumeOn(world, harness.instanceA);
    const { threadId: open } = resultOf<{ threadId: string }>(await call(world, "comment_on_document", { blockId: "b0", find: "world", text: "Bigger?" }));
    const { threadId: settled } = resultOf<{ threadId: string }>(await call(world, "comment_on_document", { blockId: "b1", text: "Cut?" }));
    const conn = await harness.instanceA.openDirectConnection(documentSpaceDocName(world.projectId, world.spaceId), {});
    try {
      await conn.transact((doc) => {
        (documentCommentThreads(doc).get(settled) as Y.Map<unknown>).set("resolved", true);
      });
    } finally {
      await conn.disconnect();
    }
    expect(resultOf(await call(world, "read_document_assignments", { threadIds: [open, settled, randomUUID()] }))).toEqual({
      threads: [{ threadId: open, authorId: world.userId, blockId: "b0", quotedText: "world" }],
    });
  });
});
