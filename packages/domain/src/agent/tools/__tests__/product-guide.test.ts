// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The product guide answers how the reader operates our product.
 *
 * It is the one place that says where to click: the model cannot see the
 * reader's screen, and before this tool it guessed. What can be worked out
 * from a rule the canvas itself enforces is worked out from that rule, and
 * every control with words on it is named by the message the reader's screen
 * shows, in the reader's language.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, beforeAll } from "vitest";
import { loadLocales, runWithLocale } from "@breatic/core";
import { canConnect, canGenerate, t, type NodeType } from "@breatic/shared";

import { CANVAS_TOOLS, TOOL_MAP } from "@domain/agent/tools/index.js";
import { GET_PRODUCT_GUIDE } from "@domain/agent/tools/tool-names.js";
import { productGuide, renderProductGuide } from "@domain/agent/tools/product-guide.js";

/** The node types the reader can create and that the guide speaks about. */
const CREATABLE: readonly NodeType[] = ["text", "image", "audio", "video"];

/**
 * Read the guide as the model reads it.
 * @returns The guide's text.
 */
async function guide(): Promise<string> {
  return renderProductGuide();
}

/** The guide's own source, where every message id it shows is spelled out. */
const source = readFileSync(resolve(import.meta.dirname, "..", "product-guide.ts"), "utf8");

/**
 * Every message id the guide spells out in a `t("…")` call.
 * @returns The ids, in source order.
 */
function messageIds(): string[] {
  return [...source.matchAll(/\bt\("([\w.-]+)"\)/g)].map((m) => m[1] ?? "");
}

beforeAll(() => {
  loadLocales();
});

describe("the guide as a tool", () => {
  it("is registered, and reaches a chat turn", () => {
    expect(Object.keys(TOOL_MAP)).toContain(GET_PRODUCT_GUIDE);
    expect(CANVAS_TOOLS).toContain(GET_PRODUCT_GUIDE);
  });

  it("declares the line the panel shows while it runs", () => {
    const metadata = (productGuide as { metadata?: { runningLine?: string } }).metadata;
    expect(metadata?.runningLine).toBe("chat.tool.readingGuide");
  });

  it("says in its description what it covers, and how to name what it describes", () => {
    const description: unknown = productGuide.description;
    const said = typeof description === "string" ? description.replace(/\s+/g, " ") : "";
    expect(said).toMatch(/canvas/i);
    expect(said).toMatch(/document/i);
    expect(said).toMatch(/cannot see/i);
    expect(said).toMatch(/icon/i);
  });
});

describe("what the guide says", () => {
  it("covers every part the reader asks about", async () => {
    const text = await guide();
    for (const heading of [
      "## Spaces",
      "## Making nodes",
      "## Filling a node",
      "## Generating",
      "## Inside the generation panel",
      "## Source slots",
      "## Connections",
      "## Focus crops",
      "## Mentions",
      "## Groups and undo",
      "## Proposal cards",
      "## Document spaces",
    ]) {
      expect(text).toContain(heading);
    }
  });

  it("says a reference is wired, then chosen from the prompt's list", async () => {
    // Three halves, each of which has been the whole sentence at some point and
    // read as complete: the edge that offers the node, the @ that opens the
    // list, and the choice that inserts the mention. Without the edge a reader
    // types @ over a node nothing points at; without the @ they wire and submit
    // a run with no source; told to type the name instead of choosing, they get
    // no mention at all, and a name with a space in it closes the list.
    const mentions = (await guide()).split("## Mentions")[1]?.split("\n## ")[0] ?? "";
    expect(mentions).toMatch(/connect/i);
    expect(mentions).toMatch(/type @/);
    expect(mentions).toMatch(/choose from the list/i);
  });

  it("says the @ list also holds focus crops, less what the mode cannot take", async () => {
    // The list is the pool the panel builds: edges in, this node's focus
    // crops, filtered by what the current mode and model accept.
    const mentions = (await guide()).split("## Mentions")[1]?.split("\n## ")[0] ?? "";
    expect(mentions).toMatch(/focus crops/i);
    expect(mentions).toMatch(/current mode and model cannot take/i);
  });

  it("says how to take a focus crop, and that it needs no connection", async () => {
    const focus = (await guide()).split("## Focus crops")[1]?.split("\n## ")[0] ?? "";
    expect(focus).toContain(`"${t("canvas.generatePanel.focus")}"`);
    expect(focus).toContain(`"${t("canvas.generatePanel.focusConfirm")}"`);
    expect(focus).toMatch(/needs no connection/i);
  });

  it("describes the generate button by its look, since it has no words", async () => {
    const text = await guide();
    expect(text).toMatch(/round button with an upward arrow/i);
  });

  it("says a proposal needs a canvas open, and that pressing without one shows a message", async () => {
    // The card itself carries no such text: pressing its button raises a toast.
    const text = await guide();
    expect(text).toMatch(/pressing it shows the message "[^"]+" and places nothing/);
    expect(text).toContain(t("chat.proposal.needCanvas"));
  });

  it("says a placed proposal arrives with its prompt, marks and mentions written", async () => {
    // Steps written from a guide that left this out told the reader to write a
    // prompt the placing had already written.
    const proposals = (await guide()).split("## Proposal cards")[1]?.split("\n## ")[0] ?? "";
    expect(proposals).toMatch(/prompt already written/i);
    expect(proposals).toMatch(/square brackets/i);
    expect(proposals).toMatch(/already mentions the empty node/i);
  });

  it("says a code block is three backticks followed by a space", async () => {
    // The input rule only fires on the space after the fence.
    expect(await guide()).toMatch(/three backticks then a space for a code block/);
  });

  it("lists which nodes generate, from the rule the canvas enforces", async () => {
    const text = await guide();
    const generating = CREATABLE.filter((type) => canGenerate(type));
    const line = text.split("\n").find((l) => l.startsWith("Nodes that generate:"));
    expect(line).toBe(`Nodes that generate: ${generating.join(", ")}.`);
  });

  it("lists what connects into each node, from the rule the canvas enforces", async () => {
    const text = await guide();
    for (const target of CREATABLE) {
      const from = CREATABLE.filter((source) => canConnect(source, target));
      expect(text).toContain(`- into ${target}: ${from.join(", ")}`);
    }
  });
});

describe("in the reader's language", () => {
  it("names every control it quotes the way a Chinese screen shows it", async () => {
    // Run in a locale whose words differ from the English literals, so a
    // control name written out in English instead of read through t() shows.
    const text = await runWithLocale("zh-CN", guide);
    const ids = messageIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const shown = runWithLocale("zh-CN", () => t(id));
      expect(shown, id).not.toBe(id);
      expect(text, id).toContain(`"${shown}"`);
    }
  });

  it("names the document block menu rows through the locale", async () => {
    const text = await runWithLocale("zh-CN", guide);
    const handle = text.split("Hovering a line")[1]?.split("\n")[0] ?? "";
    for (const id of ["blockType", "align", "color"]) {
      expect(handle).toContain(`"${runWithLocale("zh-CN", () => t(`spaces.document.commands.${id}`))}"`);
    }
    expect(text).toContain(`"${runWithLocale("zh-CN", () => t("spaces.document.commands.blockType"))}"`);
  });
});

describe("the guide's source", () => {
  it("spells every message id out, where the missing-key check can read it", () => {
    const calls = source.match(/\bt\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/^t\("[\w.-]+"\)$/);
  });

  it("does not name the generate button by its hidden label", () => {
    expect(source).not.toContain("canvas.generatePanel.execute");
  });
});
