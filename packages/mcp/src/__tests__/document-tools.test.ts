// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commentOnDocument, deleteDocumentBlocks, editDocumentText, insertDocumentBlocks, readDocument } from "@mcp/tools/document-tools.js";
import { markdownToBlocks } from "@mcp/tools/markdown.js";
import { stubDeps, type ApiCall } from "@mcp/__tests__/tool-deps.js";

const PROJECT = randomUUID();
const SPACE = randomUUID();
const WHERE = { projectId: PROJECT, spaceId: SPACE };
const PREFIX = "https://assets.example.com/";

describe("read_document", () => {
  it("gives each block as Markdown and plain text, says what its Markdown loses, and names the people", async () => {
    const [plain] = await markdownToBlocks("Hello **world**");
    const colored = { ...(await markdownToBlocks("Red words"))[0]!, props: { textColor: "red", backgroundColor: "default", textAlignment: "left" } };
    const author = randomUUID();
    const result = {
      blocks: [
        { id: "b1", type: "paragraph", text: "Hello world", block: plain },
        { id: "b2", type: "paragraph", text: "Red words", block: colored },
        { id: "b3", type: "unsupportedBlock", text: "", block: { type: "unsupportedBlock" }, unsupported: true },
      ],
      threads: [{ threadId: "t1", blockId: "b1", quotedText: "world", resolved: false, comments: [{ id: "c1", userId: author, text: "Nice" }] }],
      people: [{ userId: author, you: false, blockId: "b2", selectedText: "Red" }],
    };
    const { deps, submitted } = stubDeps({
      reply: () => ({ status: "done", result }),
      api: (call) => (call.path === "/users" ? [{ id: author, username: "Ada" }] : []),
    });
    const { value } = (await readDocument.run(deps, WHERE)) as { value: { blocks: Array<Record<string, unknown>>; threads: unknown[]; people: unknown[]; names: unknown } };
    expect(submitted.map((c) => [c.type, c.spaceId])).toEqual([["read_document", SPACE]]);
    expect(value.blocks).toEqual([
      { id: "b1", type: "paragraph", markdown: "Hello **world**", text: "Hello world", notInMarkdown: ["comments"] },
      { id: "b2", type: "paragraph", markdown: "Red words", text: "Red words", notInMarkdown: ["text color"] },
      { id: "b3", type: "unsupportedBlock", markdown: "", text: "", notInMarkdown: [], unsupported: true },
    ]);
    expect(value.threads).toEqual(result.threads);
    expect(value.people).toEqual(result.people);
    expect(value.names).toEqual({ users: { [author]: "Ada" }, agents: {} });
  });
});

/**
 * A server that answers the media routes: our prefix, one fetch that lands and one that fails.
 * @param call - The request.
 * @returns The answer.
 */
function mediaServer(call: ApiCall): unknown {
  if (call.path === "/assets/upload-config") return { assetUrlPrefix: PREFIX, uploadStatusPollSeconds: 0 };
  if (call.path === "/assets/ingest-url") return { storage_key: (call.body as { url: string }).url.includes("good") ? "k-good" : "k-bad" };
  if (call.path === "/assets/upload-status") {
    const key = String(call.query?.key);
    return {
      items: [
        key === "k-good"
          ? { key, state: "completed", result: { assetId: "a", fileUrl: `${PREFIX}stored.png`, kind: "image", width: 800, height: 600 } }
          : { key, state: "failed", reason: "unreachable" },
      ],
    };
  }
  return undefined;
}

describe("insert_document_blocks", () => {
  it("parses the Markdown, brings outside images into storage, and inserts the blocks after the one named", async () => {
    const { deps, submitted, calls } = stubDeps({ reply: () => ({ status: "done", result: { blockIds: ["n1", "n2", "n3"] } }), api: mediaServer });
    const markdown = `# Plan\n\n![ours](${PREFIX}x.png)\n\n![good](https://elsewhere.example.com/good.png)\n\n![bad](https://elsewhere.example.com/bad.png)\n\n![inline](data:image/png;base64,AAAA)`;
    const { value } = await insertDocumentBlocks.run(deps, { ...WHERE, afterBlockId: "b1", markdown });
    expect(value).toEqual({ blockIds: ["n1", "n2", "n3"], mediaLeftOut: 2 });
    const sent = submitted[0]!.params as { afterBlockId: string; blocks: Array<{ type: string; props: Record<string, unknown> }> };
    expect(sent.afterBlockId).toBe("b1");
    expect(sent.blocks.map((b) => [b.type, b.props.url])).toEqual([
      ["heading", undefined],
      ["image", `${PREFIX}x.png`],
      ["image", `${PREFIX}stored.png`],
    ]);
    expect(sent.blocks[2]!.props).toMatchObject({ mediaWidth: 800, mediaHeight: 600 });
    expect(calls.filter((c) => c.path === "/assets/ingest-url").map((c) => c.body)).toEqual([
      { url: "https://elsewhere.example.com/good.png", project_id: PROJECT, space_id: SPACE },
      { url: "https://elsewhere.example.com/bad.png", project_id: PROJECT, space_id: SPACE },
    ]);
  });

  it("asks nothing about media when the Markdown has none", async () => {
    const { deps, calls } = stubDeps({ reply: () => ({ status: "done", result: { blockIds: ["n1"] } }) });
    expect((await insertDocumentBlocks.run(deps, { ...WHERE, markdown: "Just words" })).value).toEqual({ blockIds: ["n1"], mediaLeftOut: 0 });
    expect(calls).toEqual([]);
  });

  it("refuses Markdown that parses into no block", async () => {
    const { deps, submitted } = stubDeps();
    await expect(insertDocumentBlocks.run(deps, { ...WHERE, markdown: "   " })).rejects.toMatchObject({ reason: "invalid_request" });
    expect(submitted).toEqual([]);
  });
});

describe("edit, delete and comment", () => {
  it("sends each as one command", async () => {
    const { deps, submitted } = stubDeps();
    await editDocumentText.run(deps, { ...WHERE, blockId: "b1", find: "teh", replace: "the" });
    await deleteDocumentBlocks.run(deps, { ...WHERE, blockIds: ["b2"] });
    await commentOnDocument.run(deps, { ...WHERE, text: "Check this", blockId: "b1", find: "the" });
    await commentOnDocument.run(deps, { ...WHERE, text: "Done", threadId: "t1" });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([
      ["edit_document_text", { blockId: "b1", find: "teh", replace: "the" }],
      ["delete_document_blocks", { blockIds: ["b2"] }],
      ["comment_on_document", { text: "Check this", blockId: "b1", find: "the" }],
      ["comment_on_document", { text: "Done", threadId: "t1" }],
    ]);
  });
});
