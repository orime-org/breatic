// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { blockToMarkdown, markdownToBlocks, notInMarkdown, settleMedia, type DocumentBlock } from "@mcp/tools/markdown.js";

describe("markdownToBlocks", () => {
  it("parses Markdown into the document's blocks", async () => {
    const blocks = await markdownToBlocks("# Title\n\nHello **world**");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph"]);
    expect((blocks[0]!.props as { level: number }).level).toBe(1);
    expect(blocks[1]!.content).toEqual([
      { type: "text", text: "Hello ", styles: {} },
      { type: "text", text: "world", styles: { bold: true } },
    ]);
  });

  it("brings a heading deeper than the body carries up to its deepest level", async () => {
    const [heading] = await markdownToBlocks("###### Deep");
    expect(heading!.type).toBe("heading");
    expect((heading!.props as { level: number }).level).toBe(3);
  });
});

describe("blockToMarkdown", () => {
  it("writes a block back as Markdown", async () => {
    const [block] = await markdownToBlocks("Hello **world**");
    expect((await blockToMarkdown(block!)).trim()).toBe("Hello **world**");
  });
});

describe("notInMarkdown", () => {
  it("names what a block carries that its Markdown loses", () => {
    const block: DocumentBlock = {
      id: "b1",
      type: "paragraph",
      props: { textColor: "red", backgroundColor: "default", textAlignment: "center" },
      content: [{ type: "text", text: "x", styles: { underline: true, backgroundColor: "yellow" } }],
      children: [],
    };
    expect(notInMarkdown(block, true).sort()).toEqual(["alignment", "background color", "comments", "text color", "underline"]);
  });

  it("names nothing for a block Markdown carries whole", () => {
    expect(notInMarkdown({ id: "b", type: "paragraph", props: { textColor: "default", backgroundColor: "default", textAlignment: "left" }, content: [{ type: "text", text: "x", styles: { bold: true } }], children: [] }, false)).toEqual([]);
  });
});

describe("settleMedia", () => {
  it("keeps media the decision keeps, with the address and size it gives, and drops the rest with a count", async () => {
    const blocks = await markdownToBlocks("![a](https://ours/a.png)\n\n![b](https://outside/b.png)\n\n![c](ftp://nope/c.png)\n\nText");
    const decide = async (url: string): Promise<{ url: string; width: number; height: number } | null> =>
      url.startsWith("https://ours/") ? { url, width: 0, height: 0 } : url.startsWith("https://outside/") ? { url: "https://ours/b.png", width: 640, height: 480 } : null;
    const { blocks: settled, leftOut } = await settleMedia(blocks, decide);
    expect(leftOut).toBe(1);
    expect(settled.map((b) => [b.type, (b.props as { url?: string }).url])).toEqual([
      ["image", "https://ours/a.png"],
      ["image", "https://ours/b.png"],
      ["paragraph", undefined],
    ]);
    expect(settled[1]!.props).toMatchObject({ mediaWidth: 640, mediaHeight: 480 });
  });
});
