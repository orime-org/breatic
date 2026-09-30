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

/**
 * A node type as the create menus name it, quoted.
 * @param type - A creatable type.
 * @returns Its menu label between double quotes.
 */
function label(type: (typeof CREATABLE)[number]): string {
  const id = { text: "canvas.handle.nodeText", image: "canvas.handle.nodeImage", audio: "canvas.handle.nodeAudio", video: "canvas.handle.nodeVideo" }[type];
  return `"${t(id)}"`;
}

/**
 * A web source file, read as text.
 * @param path - Its path under packages/web/src.
 * @returns The file's text.
 */
function webSource(path: string): string {
  return readFileSync(resolve(import.meta.dirname, "../../../../../web/src", path), "utf8");
}

/**
 * Assert each row is named in the text, and the rows appear in the order given.
 * A row is one or more message ids of which any one may stand for it (the two
 * words of a lock / unlock toggle); its position is the first one found.
 * @param text - Where the rows should appear.
 * @param rows - The rows, in the order the screen shows them.
 */
function expectRowsInOrder(text: string, rows: readonly (readonly string[])[]): void {
  // A regex that stopped matching the web source yields no rows, and an empty
  // list is trivially in order.
  expect(rows.length).toBeGreaterThan(0);
  const at = rows.map((ids) => {
    const found = ids.map((id) => text.indexOf(`"${t(id)}"`)).filter((i) => i >= 0);
    return found.length > 0 ? Math.min(...found) : -1;
  });
  expect(at, rows.map((ids) => ids.join("|")).join(", ")).not.toContain(-1);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
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
      "## The top bar",
      "## Spaces",
      "## The chat panel",
      "## Making nodes",
      "## Filling a node",
      "## Node menus",
      "## Notes",
      "## Moving around the canvas",
      "## Generating",
      "## Inside the generation panel",
      "## Source slots",
      "## Connections",
      "## Focus crops",
      "## Mentions",
      "## Groups and undo",
      "## Proposal cards",
      "## Document spaces",
      "## When something is wrong",
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
    expect(proposals).toMatch(/with its mode, model and the settings the proposal chose already set/);
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
    // The placing mentions a feeder only where a mention is what picks it; a
    // node feeding one of the mode's slots, empty or generated, gets none.
    const proposals = section("Proposal cards");
    expect(proposals).toMatch(/source slots: it is not mentioned/i);
    expect(proposals).toMatch(/file or its generated result/i);
    expect(proposals).toMatch(/presses that slot's button and clicks the node/i);
  });

  it("says what a model with no prompt box shows instead", () => {
    const proposals = section("Proposal cards");
    expect(proposals).toContain(`"${t("chat.proposal.settingsReady")}"`);
    expect(proposals).toContain(`"${t("canvas.generatePanel.promptNotUsed")}"`);
  });

  it("says a code block is three backticks followed by a space", () => {
    // The input rule only fires on the space after the fence.
    expect(renderProductGuide()).toMatch(/three backticks then a space for a code block/);
  });

  it("says the left menu shows icons that name themselves when hovered", () => {
    // Those two buttons carry no words; their names live in the tooltips.
    const making = section("Making nodes");
    expect(making).toMatch(/floating menu of icons runs along the left edge; each names itself when hovered/i);
    expect(making).toMatch(/sparkle/i);
    expect(making).toMatch(/arrow pointing up out of a tray/i);
  });

  it("says the task marks are icons in four states, with the count on hover", () => {
    const generating = section("Generating");
    expect(generating).toMatch(/spinning circle \(running\)/);
    expect(generating).toMatch(/a clock \(expired\)/);
    expect(generating).toMatch(/Hovering one shows how many/);
    expect(generating).toMatch(/Zoomed far out, only the spinning one remains/);
  });

  it("says letters after @ narrow a list of at most eight rows", () => {
    expect(section("Mentions")).toMatch(/narrow the list, which shows up to eight rows/i);
  });

  it("describes the selection bar by its icons, since its buttons show no name", () => {
    const doc = section("Document spaces");
    expect(doc).toMatch(/The other buttons show no name on hover/);
    expect(doc).not.toMatch(/each nam(es|ing) itself when hovered/i);
    expect(doc).toMatch(/speech bubble shows "[^"]+" marked not open yet/);
    expect(doc).toMatch(/AI menu's commands look available but do nothing yet/);
  });

  it("quotes no name the screen only gives a screen reader", () => {
    // Each of these is an aria-label, a sr-only span or a fallback the pill
    // never shows (measured in a real browser); a reader cannot see them.
    const text = renderProductGuide();
    for (const id of [
      "canvas.generatePanel.audioSettings",
      "canvas.generatePanel.videoParams",
      "canvas.generatePanel.focusCropTag",
      "spaces.document.commands.bold",
      "spaces.document.commands.italic",
      "spaces.document.commands.strike",
      "spaces.document.commands.underline",
      "spaces.document.commands.link",
      "spaces.document.commands.code",
      "chrome.tooltip.agentHide",
      "chrome.tooltip.agentShow",
      "chrome.tooltip.revealActiveTab",
      "chrome.tooltip.newSpace",
      "chrome.tooltip.openHistory",
      "chrome.tooltip.newConversation",
      "spaces.tab.closeAria",
      "chat.composer.attach",
      "chat.conversation.rowActions",
      "viewportToolbar.fitAria",
      "viewportToolbar.zoomResetAria",
      "spaces.document.docMenu.label",
    ]) {
      // Two ids can share a word; the check is on this id's word, so it only
      // counts when no id the guide does quote reads the same.
      if (messageIds().some((quotedId) => t(quotedId) === t(id))) continue;
      expect(text, id).not.toContain(`"${t(id)}"`);
    }
  });

  it("lists the node and group menus' rows in the order the menu shows them", () => {
    // One row per run of adjacent source lines: a lock / unlock or node / group
    // pair is one row written as a ternary over two lines.
    const menu = webSource("spaces/canvas/NodeContextMenu.tsx");
    const rows: string[][] = [];
    let last = -2;
    menu.split("\n").forEach((line, n) => {
      const ids = [...line.matchAll(/'(canvas\.(?:nodeMenu|contextMenu|group)\.\w+)'/g)].map((m) => m[1] ?? "");
      if (ids.length === 0) return;
      if (n === last + 1) rows[rows.length - 1]?.push(...ids);
      else rows.push(ids);
      last = n;
    });
    const groupOnly = (id: string): boolean =>
      id.startsWith("canvas.group.") || id === "canvas.contextMenu.deleteGroup";
    const menus = section("Node menus");
    // The node's own list ends where the group's begins, so a word a later
    // sentence repeats cannot stand in for a missing row.
    const [own = "", rest = ""] = menus.split("A group's menu");
    const groupSentence = rest.split(". ")[0] ?? "";
    expectRowsInOrder(own, rows.map((ids) => ids.filter((id) => !groupOnly(id))).filter((ids) => ids.length > 0));
    // A group's menu starts at Copy; before it are rows only a node has.
    const fromCopy = rows.slice(rows.findIndex((ids) => ids.includes("canvas.contextMenu.copy")));
    expectRowsInOrder(groupSentence, fromCopy.map((ids) => (ids.some(groupOnly) ? ids.filter(groupOnly) : ids)));
  });

  it("lists the selection menu's rows in the order the menu shows them", () => {
    const menu = webSource("spaces/canvas/SelectionContextMenu.tsx");
    const ids = [...menu.matchAll(/t\('([\w.]+)'\)/g)].map((m) => [m[1] ?? ""]);
    const sentence = section("Node menus").split("right-clicking the selection opens")[1]?.split(". ")[0] ?? "";
    expectRowsInOrder(sentence, ids);
  });

  it("names the view bar's buttons by their tooltips, in the bar's order", () => {
    const bar = webSource("pages/project/chrome/viewport-toolbar/ViewportToolbar.tsx");
    const ids = [...bar.matchAll(/tooltip=\{t\('([\w.]+)'\)\}/g)].map((m) => [m[1] ?? ""]);
    expectRowsInOrder(section("Moving around the canvas"), ids);
  });

  it("says the left menu's upload picker lists only what its accept list takes", () => {
    // Dropping takes any file; the picker is narrower, and the reader told to
    // pick a PDF there finds it greyed out.
    const page = webSource("pages/project/ProjectPage.tsx");
    expect(page).toContain("accept='image/*,video/*,audio/*,text/*'");
    const making = section("Making nodes");
    expect(making).toMatch(/file picker that lists pictures, videos, sounds and plain text files/);
    expect(making).toMatch(/PDF, Word and Excel files go in by dropping or pasting them/);
  });

  it("says only the picture and video panels show the no-prompt notice", () => {
    const users = ["spaces/canvas/generate/GeneratePanelContainer.tsx", "spaces/canvas/generate/VideoGeneratePanelContainer.tsx"];
    for (const path of users) expect(webSource(path)).toContain("<PromptNotUsedNotice");
    expect(webSource("spaces/canvas/generate/AudioGeneratePanelContainer.tsx")).not.toContain("<PromptNotUsedNotice");
    const proposals = section("Proposal cards");
    expect(proposals).toMatch(new RegExp(`picture or video panel shows "${t("canvas.generatePanel.promptNotUsed").replace(/\./g, "\\.")}"`));
    expect(proposals).toMatch(/a sound panel still shows a box that holds only the proposal's bracketed spots/);
  });

  it("names the picture panel's settings pill by the word it shows when there is nothing to summarise", () => {
    // The pill falls back to this word when the model has no values to show,
    // so a reader with such a model sees it on screen.
    expect(webSource("spaces/canvas/generate/RatioResolutionPicker.tsx")).toContain(
      ".join(' · ') || t('canvas.generatePanel.imageParams')",
    );
    expect(section("Inside the generation panel")).toContain(
      `On the picture panel a model with no settings shows the pill as "${t("canvas.generatePanel.imageParams")}"`,
    );
  });

  it("says the reader is an editor, since people who can only view get no chat", () => {
    expect(webSource("pages/project/ProjectPage.tsx")).toContain("collapsed || isViewer ? null");
    expect(renderProductGuide()).toMatch(/^You are talking to someone who can edit this project/);
  });

  it("says only a list's own shortcut turns it back to plain text", () => {
    expect(webSource("spaces/document/document-block-run.ts")).toMatch(
      /LIST_ROWS[^=]*=\s*new Set<BlockTypeId>\(\[\s*'bullet-list',\s*'ordered-list',\s*'task-list',\s*\]\)/,
    );
    const doc = section("Document spaces");
    expect(doc).toMatch(/Pressing a list's shortcut again on an item of that list turns it back to plain text/);
    expect(doc).toMatch(/a heading's or code block's own shortcut pressed again changes nothing/);
  });

  it("says Enter and Shift+Enter swap roles in a code block", () => {
    const doc = section("Document spaces");
    expect(doc).toMatch(/In a code block Enter adds a line inside it/);
    expect(doc).toMatch(/Shift\+Enter there starts a new block below/);
  });

  it("says a sound panel can mention only connected text", () => {
    const audio = webSource("spaces/canvas/generate/AudioGeneratePanelContainer.tsx");
    expect(audio).toContain("referenceKinds={NO_REFERENCE_KINDS}");
    // Every editor the sound panel draws takes no reference kinds.
    expect(audio).not.toMatch(/referenceKinds=\{(?!NO_REFERENCE_KINDS\})/);
    expect(section("Inside the generation panel")).toMatch(/Here only a connected text node can be mentioned/);
  });

  it("says the X on a connected node's chip deletes the connection", () => {
    expect(webSource("spaces/canvas/generate/remove-reference-row.ts")).toContain("removeEdge(projectId, spaceId, item.refId)");
    expect(section("Inside the generation panel")).toMatch(/On a connected node's chip the X deletes that connection from the canvas/);
  });

  it("says how to put a node into a group and take it out", () => {
    expect(section("Groups and undo")).toMatch(/Drag a node into an unlocked group to add it: it joins when its centre ends inside/);
  });

  it("says what a filled slot looks like for each kind", () => {
    const slots = section("Source slots");
    expect(slots).toMatch(/A slot holding a picture, or a video with a cover, shows that picture/);
    expect(slots).toMatch(/a slot holding a sound keeps its icon and name/);
  });

  it("says locking a space only stops renaming and deleting it", () => {
    expect(section("Spaces")).toMatch(/Locking a space only stops it being renamed or deleted; what is in it stays editable/);
  });

  it("says how to send, break a line and stop a reply", () => {
    expect(webSource("pages/project/chat/ChatComposer.tsx")).toContain("e.key === 'Enter' && !e.shiftKey");
    const chat = section("The chat panel");
    expect(chat).toMatch(/Enter sends the message and Shift\+Enter starts a new line/);
    expect(chat).toMatch(/red square, which stops the reply/);
  });

  it("names the notice a space shows when it cannot be written to", () => {
    expect(section("When something is wrong")).toContain(`"${t("spaces.readOnlyNotice")}"`);
  });

  it("says only the owner can invite", () => {
    expect(webSource("pages/project/chrome/top-bar/TopBar.tsx")).toContain("role === 'owner' ? <ShareDialog");
    const bar = section("The top bar");
    expect(bar).toMatch(/The owner also has a person icon with a plus/);
    expect(bar).toContain(`"${t("share.inviteButton")}"`);
  });

  it("says how to change the mode and the model", () => {
    const panel = section("Inside the generation panel");
    expect(panel).toMatch(/Clicking the mode lists the modes/);
    expect(panel).toMatch(/Clicking the model's name lists the current mode's models/);
  });

  it("gives an empty text node the same second line as the other empty nodes", () => {
    const filling = section("Filling a node");
    expect(filling).toContain(`"${t("canvas.nodePlaceholder.rightClickHint")}"`);
    expect(filling).toMatch(new RegExp(`"${t("canvas.nodePlaceholder.text")}" and the same smaller line`));
  });

  it("describes a proposal card's summary, run divider and model line", () => {
    const proposals = section("Proposal cards");
    expect(proposals).toMatch(/a summary of a sentence or two/);
    expect(proposals).toMatch(/a \| between runs that do not feed each other/);
    expect(proposals).toMatch(/when every generating node uses the same model and you gave a model note, a line with that model's name/);
  });

  it("says a slot-bound 📎 spot still has its note on the card", () => {
    const slot = section("Proposal cards").split("Into one of the mode's source slots")[1] ?? "";
    expect(slot).toMatch(/own material still has its 📎 note on the card; a generated result has no line/);
  });

  it("says how to indent and outdent in a document", () => {
    const doc = section("Document spaces");
    expect(webSource("spaces/document/document-tab.ts")).toContain("'Shift-Tab':");
    expect(doc).toMatch(/Tab indents the block under the one above/);
    expect(doc).toMatch(/Shift\+Tab moves it back out/);
  });

  it("lists the block menu rows in the order the menu shows them", () => {
    const handle = section("Document spaces").split("Hovering a line")[1]?.split("\n")[0] ?? "";
    // The rows in the order the menu's own table lists them.
    const rows = webSource("spaces/document/document-block-menu-rows.ts");
    expectRowsInOrder(handle, [...rows.matchAll(/labelKey: '(spaces\.document\.[\w.]+)'/g)].map((m) => [m[1] ?? ""]));
  });

  it("keeps its hand-written list of creatable types in the create menu's order", () => {
    // Read off the web menu's own list, so a type added there fails here.
    const menu = webSource("spaces/canvas/node-factory.ts");
    const listed = /CREATABLE_NODE_TYPES[^=]*=\s*\[([^\]]*)\]/.exec(menu)?.[1] ?? "";
    expect(CREATABLE).toEqual([...listed.matchAll(/'(\w+)'/g)].map((m) => m[1]));
  });

  it("lists which nodes generate, from the rule the canvas enforces", () => {
    const text = renderProductGuide();
    const generating = CREATABLE.filter((type) => canGenerate(type)).map(label);
    const line = text.split("\n").find((l) => l.startsWith("Nodes that generate:"));
    expect(line).toBe(`Nodes that generate: ${generating.join(", ")}.`);
  });

  it("lists what connects into each node, from the rule the canvas enforces", () => {
    const text = renderProductGuide();
    for (const target of CREATABLE) {
      const from = CREATABLE.filter((source) => canConnect(source, target)).map(label);
      expect(text).toContain(`- into ${label(target)}: ${from.join(", ")}`);
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
  });
});

describe("in every language", () => {
  it("never puts punctuation after a quoted message that already ends its sentence", () => {
    // A message carrying its own closing mark, followed by the guide's own
    // full stop or comma, reads as a stray second mark in that language.
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
      const text = runWithLocale(locale, renderProductGuide);
      const doubled = text.match(/"[^"\n]*[.。!！?？]"[.。,，;；:：]/g) ?? [];
      expect(doubled, locale).toEqual([]);
    }
  });
});

describe("messages the guide borrows", () => {
  it("quotes the picture placeholder for video and sound because all three read the same", () => {
    // The guide names the three empty media nodes with the picture node's
    // line; that is only true while the video and sound lines match it.
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
      runWithLocale(locale, () => {
        expect(t("canvas.nodePlaceholder.video"), locale).toBe(t("canvas.nodePlaceholder.image"));
        expect(t("canvas.nodePlaceholder.audio"), locale).toBe(t("canvas.nodePlaceholder.image"));
      });
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
