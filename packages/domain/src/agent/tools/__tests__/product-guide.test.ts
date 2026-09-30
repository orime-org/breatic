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
import { canConnect, canGenerate, t } from "@breatic/shared";

import { CANVAS_TOOLS, TOOL_MAP } from "@domain/agent/tools/index.js";
import { GET_PRODUCT_GUIDE } from "@domain/agent/tools/tool-names.js";
import { CREATABLE, productGuide, renderProductGuide } from "@domain/agent/tools/product-guide.js";

/**
 * One section of the guide, as the model reads it.
 * @param heading - The section's heading, without the hashes.
 * @returns The section's body.
 */
function section(heading: string): string {
  return renderProductGuide().split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "";
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
  it("covers every part the reader asks about", () => {
    const text = renderProductGuide();
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

  it("says a reference is wired, then chosen from the prompt's list", () => {
    // Three halves, each of which has been the whole sentence at some point and
    // read as complete: the edge that offers the node, the @ that opens the
    // list, and the choice that inserts the mention. Without the edge a reader
    // types @ over a node nothing points at; without the @ they wire and submit
    // a run with no source; told to type the name instead of choosing, they get
    // no mention at all, and a name with a space in it closes the list.
    const mentions = section("Mentions");
    expect(mentions).toMatch(/connect/i);
    expect(mentions).toMatch(/type @/);
    expect(mentions).toMatch(/choose from the list/i);
  });

  it("says the @ list also holds focus crops, less what the mode cannot take", () => {
    // The list is the pool the panel builds: edges in, this node's focus
    // crops, filtered by what the current mode and model accept.
    const mentions = section("Mentions");
    expect(mentions).toMatch(/focus crops/i);
    expect(mentions).toMatch(/current mode and model cannot take/i);
  });

  it("says how to take a focus crop, and that it needs no connection", () => {
    const focus = section("Focus crops");
    expect(focus).toContain(`"${t("canvas.generatePanel.focus")}"`);
    expect(focus).toContain(`"${t("canvas.generatePanel.focusConfirm")}"`);
    expect(focus).toMatch(/needs no connection/i);
  });

  it("describes the generate button by its look, since it has no words", () => {
    const text = renderProductGuide();
    expect(text).toMatch(/round button with an upward arrow/i);
  });

  it("says a proposal needs a canvas open, and that pressing without one shows a message", () => {
    // The card itself carries no such text: pressing its button raises a toast.
    const text = renderProductGuide();
    expect(text).toMatch(/pressing it shows the message "[^"]+" and places nothing/);
    expect(text).toContain(t("chat.proposal.needCanvas"));
  });

  it("says a placed proposal arrives with its mode, model and prompt written", () => {
    // Steps written from a guide that left this out told the reader to write a
    // prompt the placing had already written.
    const proposals = section("Proposal cards");
    expect(proposals).toMatch(/prompt written/i);
    expect(proposals).toMatch(/mode and model set/i);
  });

  it("says a proposal is grouped only when it places two or more nodes", () => {
    expect(section("Proposal cards")).toMatch(/grouped when there are two or more/i);
  });

  it("tells the two kinds of bracketed spot apart", () => {
    // A pencil spot is words to write or a setting to pick; a paperclip spot
    // is the reader's own material, which goes in an empty node.
    const proposals = section("Proposal cards");
    expect(proposals).toMatch(/✏️[^.]*(own words|pick in the panel)/);
    expect(proposals).toMatch(/📎[^.]*material/);
  });

  it("says material bound for a source slot is picked in the panel, not mentioned", () => {
    // The placing mentions an empty node only where a mention is what picks
    // it; a node feeding one of the mode's slots gets no mention.
    const proposals = section("Proposal cards");
    expect(proposals).toMatch(/source slots[^.]*not mentioned/i);
    expect(proposals).toMatch(/presses that slot's button in the panel and clicks the node/i);
  });

  it("says a model with no prompt box shows no brackets and the card lists what is left", () => {
    expect(section("Proposal cards")).toMatch(/no prompt box shows no brackets; the card lists what is left/i);
  });

  it("says a code block is three backticks followed by a space", () => {
    // The input rule only fires on the space after the fence.
    expect(renderProductGuide()).toMatch(/three backticks then a space for a code block/);
  });

  it("says the left menu shows icons that name themselves when hovered", () => {
    // Those two buttons carry no words; their names live in the tooltips.
    const making = section("Making nodes");
    expect(making).toMatch(/icons along the left edge, each naming itself when hovered/i);
    expect(making).toMatch(/sparkle/i);
    expect(making).toMatch(/upward arrow/i);
  });

  it("says the task marks are icons in four states, with the count on hover", () => {
    const generating = section("Generating");
    expect(generating).toMatch(/running, done, failed or expired/i);
    expect(generating).toMatch(/hovering one shows how many/i);
  });

  it("says letters after @ narrow a list of at most eight rows", () => {
    expect(section("Mentions")).toMatch(/narrow the list, which shows up to eight rows/i);
  });

  it("names the selection bar's comment and AI buttons as not open yet", () => {
    const doc = section("Document spaces");
    expect(doc).toMatch(/bar of buttons, each naming itself when hovered/i);
    expect(doc).not.toMatch(/looks active/i);
    expect(doc).toMatch(/marked not open yet/i);
  });

  it("lists the block menu rows in the order the menu shows them", () => {
    const handle = section("Document spaces").split("Hovering a line")[1]?.split("\n")[0] ?? "";
    const order = [
      "spaces.document.commands.blockType",
      "spaces.document.blockHandle.duplicate",
      "spaces.document.blockHandle.insertBelow",
      "spaces.document.commands.align",
      "spaces.document.commands.color",
      "spaces.document.commands.comment",
      "spaces.document.blockHandle.delete",
    ].map((id) => handle.indexOf(`"${t(id)}"`));
    expect(order.every((at) => at >= 0), order.join(",")).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("lists which nodes generate, from the rule the canvas enforces", () => {
    const text = renderProductGuide();
    const generating = CREATABLE.filter((type) => canGenerate(type));
    const line = text.split("\n").find((l) => l.startsWith("Nodes that generate:"));
    expect(line).toBe(`Nodes that generate: ${generating.join(", ")}.`);
  });

  it("lists what connects into each node, from the rule the canvas enforces", () => {
    const text = renderProductGuide();
    for (const target of CREATABLE) {
      const from = CREATABLE.filter((source) => canConnect(source, target));
      expect(text).toContain(`- into ${target}: ${from.join(", ")}`);
    }
  });
});

describe("in the reader's language", () => {
  it("names every control it quotes the way a Chinese screen shows it", () => {
    // Every quoted name in the guide comes from quoted(t(...)), so in a locale
    // whose words differ from English each quoted fragment must be one of the
    // translations; a name written out in English instead shows up as a
    // fragment no id accounts for.
    const text = runWithLocale("zh-CN", renderProductGuide);
    const shown = new Set(messageIds().map((id) => runWithLocale("zh-CN", () => `"${t(id)}"`)));
    const quotedFragments = text.match(/"[^"\n]+"/g) ?? [];
    expect(quotedFragments.length).toBeGreaterThan(0);
    for (const fragment of quotedFragments) expect(shown, fragment).toContain(fragment);
    for (const id of messageIds()) {
      expect(text, id).toContain(`"${runWithLocale("zh-CN", () => t(id))}"`);
    }
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
