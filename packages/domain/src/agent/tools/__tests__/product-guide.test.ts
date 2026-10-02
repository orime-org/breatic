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
import { getAgentConfig, loadLocales, runWithLocale } from "@breatic/core";
import { CHAT_MESSAGE_MAX_CHARS, canConnect, canGenerate, t } from "@breatic/shared";

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

/**
 * Every message id a web source names in single quotes, to check an
 * extraction against: one that skips an id reads fewer rows than the menu has.
 * @param text - The web source.
 * @returns The ids, in the order they appear.
 */
function namedIds(text: string): string[] {
  return [...text.matchAll(/'([a-z]\w*(?:\.\w+)+)'/g)].map((m) => m[1] ?? "");
}

/** The guide's own source, where every message id it shows is spelled out. */
const source = readFileSync(resolve(import.meta.dirname, "..", "product-guide.ts"), "utf8");

/** A `t("…")` call the guide makes: the id, and the sample values it fills in, if any. */
type MessageCall = [id: string, values: Record<string, number> | undefined];

/**
 * Every `t("…")` call the guide spells out, with the sample values a call
 * such as `t("chat.sources.count", { count: 3 })` fills its message with.
 * @returns The calls, in source order.
 */
function messageCalls(): MessageCall[] {
  return [...source.matchAll(/\bt\("([\w.-]+)"(?:, (\{[^}]*\}))?\)/g)].map((m) => [
    m[1] ?? "",
    m[2] === undefined
      ? undefined
      : (JSON.parse(m[2].replace(/(\w+):/g, '"$1":')) as Record<string, number>),
  ]);
}

/**
 * Every message id the guide spells out in a `t("…")` call.
 * @returns The ids, in source order.
 */
function messageIds(): string[] {
  return messageCalls().map(([id]) => id);
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
    expect(section("Proposal cards")).toMatch(/shows no credits and no run time/);
    expect(section("Proposal cards")).not.toMatch(/a clock|a star/);
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
    expect(generating).toMatch(/Zoomed far out, only the spinning icon remains/);
  });

  it("says letters after @ narrow a list of at most eight rows", () => {
    expect(section("Mentions")).toMatch(/narrow the list, which shows up to eight rows/i);
  });

  it("describes the selection bar by its icons, since its buttons show no name", () => {
    const doc = section("Document spaces");
    expect(doc).toMatch(/The other buttons show no name on hover/);
    expect(doc).not.toMatch(/each nam(es|ing) itself when hovered/i);
    expect(doc).toMatch(/The speech bubble starts a comment/);
    expect(doc).toMatch(/AI menu's commands look available but do nothing yet/);
  });

  it("walks through comments in a document: start, post, the panel, resolve and who may delete", () => {
    const doc = section("Document spaces");
    expect(doc).toMatch(/- Comments: select text and press the speech bubble/);
    expect(doc).toMatch(/"Comments" panel opens beside the text/);
    expect(doc).toMatch(/"Resolve" takes the highlight away and moves the card under "All", where "Reopen" brings it back/);
    expect(doc).toMatch(/for whoever wrote the first comment or a project owner/);
    expect(doc).toMatch(/Viewers can open the panel and read/);
    expect(doc).toMatch(/Not available yet: the AI commands/);
    expect(doc).not.toMatch(/Not available yet: comments/);
    expect(doc).not.toMatch(/marked not open yet\)/);
  });

  it("walks through a storyboard split into shots, and says each mode keeps its own prompt", () => {
    const panel = section("Inside the generation panel");
    expect(panel).toMatch(/- Storyboard, on the video models that offer it/);
    expect(panel).toMatch(/"Edit per shot" at the right end of that row splits it by hand/);
    expect(panel).toMatch(/the right end of the row reads "Add shot" then "Back to auto storyboard"/);
    expect(panel).toMatch(/the shots' seconds keep adding up to the video's length/);
    expect(panel).toMatch(/each mode keeps its own words/);
    expect(section("Generating")).toMatch(/"Shot 2 is empty"/);
    expect(section("Groups and undo")).toMatch(/a video's storyboard and its shots/);
  });

  it("says when each storyboard control is greyed and what happens when the shots stop fitting", () => {
    const panel = section("Inside the generation panel");
    // VideoGeneratePanelContainer.tsx: one lastFocusedBox, written by the shots and by the main prompt.
    expect(panel).toMatch(/puts it in that shot box if the prompt box clicked into last was a shot/);
    expect(panel).toMatch(/after clicking the main prompt box, it goes into the first shot/);
    expect(panel).toMatch(/minus is greyed at one second or when there is only one shot/);
    expect(panel).toMatch(/plus is greyed when no other shot has a second to spare/);
    expect(panel).toMatch(/"Remove" is greyed while only one shot is left/);
    // storyboard-durations.ts stepShot: later shots first, then earlier ones.
    expect(panel).toMatch(/the minus gives one to the shot after it, or to the one before it on the last shot/);
    // storyboard-durations.ts addShot: null when total <= shot count, whatever each shot holds.
    expect(panel).toMatch(/"Lengthen the video to add a shot" when the video has no more seconds than there are shots/);
    // storyboard-durations.ts removeShot: re-splits only once the shots fit the seconds.
    expect(panel).toMatch(/remove shots until there are no more shots than seconds, and the rest are re-split, or pick a duration at least as long as the number of shots/);
    expect(panel).not.toMatch(/always add up/);
  });

  it("gives the picture panel no source slot, since main removed the only one it had", () => {
    expect(section("Inside the generation panel")).toMatch(/- Picture panel: tools "Reference" and "Focus", with no source slots/);
    expect(section("Source slots")).toMatch(/The picture panel has none/);
  });

  it("says which comment controls depend on the thread or the panel being open", () => {
    const doc = section("Document spaces");
    expect(doc).toMatch(/a resolved card takes no replies until it is reopened/);
    // DocumentCommentDraftCard.tsx: the outside-press check is against the whole card.
    expect(doc).toMatch(/With nothing typed yet, clicking anywhere outside its card also drops it/);
    expect(doc).toMatch(/The three dots are hidden while the comments panel is open/);
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
    expect(rows.flat()).toEqual(namedIds(menu));
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
    expect(ids.flat()).toEqual(namedIds(menu));
    const sentence = section("Node menus").split("inside that frame opens")[1]?.split(". ")[0] ?? "";
    expectRowsInOrder(sentence, ids);
  });

  it("names the view bar's buttons by their tooltips, in the bar's order", () => {
    const bar = webSource("pages/project/chrome/viewport-toolbar/ViewportToolbar.tsx");
    const ids = [...bar.matchAll(/tooltip=\{t\('([\w.]+)'\)\}/g)].map((m) => [m[1] ?? ""]);
    // Every tooltip the bar sets is one plain message, or a button would be skipped.
    expect(ids).toHaveLength([...bar.matchAll(/tooltip=/g)].length);
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
    expect(slots).toMatch(/a slot\s+holding a sound, or a video without a cover, keeps its icon and name and its border stands out more/);
    expect(slots).not.toMatch(/coloured/);
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
    const handle = section("Document spaces").split("Hovering any other line")[1]?.split("\n")[0] ?? "";
    // The rows in the order the menu's own table lists them.
    const rows = webSource("spaces/document/document-block-menu-rows.ts");
    const ids = [...rows.matchAll(/labelKey: '(spaces\.document\.[\w.]+)'/g)].map((m) => m[1] ?? "");
    expect(ids).toEqual(namedIds(rows));
    expectRowsInOrder(handle, ids.map((id) => [id]));
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
    const shown = new Set(messageCalls().map(([id, values]) => runWithLocale("zh-CN", () => `"${t(id, values)}"`)));
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

  it("never runs a quoted message straight into the next sentence", () => {
    // A message with no closing mark of its own, followed by a new sentence,
    // reads as one sentence in every language.
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
      const text = runWithLocale(locale, renderProductGuide);
      const joined = text.match(/"[^"\n]*[^.。!！?？\s"]" [A-Z]/g) ?? [];
      expect(joined, locale).toEqual([]);
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
    // A sample number may fill a message that carries one; nothing else goes in.
    for (const call of calls) expect(call).toMatch(/^t\("[\w.-]+"(?:, \{(?: ?\w+: \d+,?)+ ?\})?\)$/);
  });

  it("does not name the generate button by its hidden label", () => {
    expect(source).not.toContain("canvas.generatePanel.execute");
  });
});

describe("what the guide says about each surface", () => {
  it("reads the message and attachment limits off their sources", () => {
    const chat = section("The chat panel");
    expect(chat).toContain(`up to ${CHAT_MESSAGE_MAX_CHARS.toLocaleString("en")} characters`);
    expect(chat).toContain(`attaches up to ${String(getAgentConfig().attachment_max_items)} pictures`);
    expect(renderProductGuide()).not.toMatch(/at most 50 connections/);
    // Written out by hand, the numbers would stay behind when their sources change.
    expect(source).not.toMatch(/10,000|up to ten|at most 50/);
  });

  it("greys generate on exactly the node types that do not generate", () => {
    const idle = CREATABLE.filter((type) => !canGenerate(type)).map(label);
    const menus = section("Node menus");
    for (const name of idle) expect(menus).toContain(name);
    expect(menus).toContain(`(greyed on ${idle.join(", ")})`);
  });

  it("says the send button is a dark square and when a message can go", () => {
    const chat = section("The chat panel");
    expect(chat).toMatch(/dark square button with an upward arrow/);
    expect(chat).toMatch(/only when the box has some words, no reply is being written and every attachment has finished uploading/);
    expect(chat).not.toMatch(/a Sources button/);
  });

  it("says each notification item has one of its two buttons, and the answer button leaves the page", () => {
    const top = section("The top bar");
    expect(top).toMatch(/An item someone is waiting on.*which leaves this page.*Any other item shows/s);
    expect(top).not.toMatch(/each item has/);
  });

  it("says a transfer waits for the other member to accept", () => {
    expect(section("The top bar")).toMatch(/Nothing changes until that member accepts: then they become the owner and the reader becomes an editor/);
  });

  it("says a restored space comes back to the list, not as a tab", () => {
    expect(section("Spaces")).toMatch(/brings the space back into "[^"]+", not as a tab: open it from there/);
  });

  it("says which copies are prefixed and what a placed proposal node is called", () => {
    const filling = section("Filling a node");
    expect(filling).toMatch(/nodes copied along inside a group keep their names/);
    expect(filling).toMatch(/placed from a proposal card has the name the card showed/);
  });

  it("says the failure box shows only on an empty media node", () => {
    const filling = section("Filling a node");
    expect(filling).toMatch(/An empty picture, video or sound node with a failed or expired task and nothing running/);
    expect(filling).toMatch(/a text node whose task failed, such as a reading made with "[^"]+", does not show this box/);
    expect(filling).toMatch(/Extraction failed: and the file's name/);
  });

  it("says files dropped on a node still make new nodes", () => {
    expect(section("Making nodes")).toMatch(/Files dropped on top of a node, or pasted while a node is selected, still make new nodes/);
  });

  it("offers Group only when every selected node is loose", () => {
    expect(section("Node menus")).toMatch(/only when, notes aside, every selected node is loose/);
    expect(section("Groups and undo")).toMatch(/One group or grouped node in the selection takes the offer away/);
    expect(section("Groups and undo")).toMatch(/making it bigger takes in the loose nodes whose centres end up inside/);
  });

  it("says when the undo keys work and what undo takes back", () => {
    const undo = section("Groups and undo");
    expect(undo).toMatch(/after pressing a button in this chat, click empty canvas first/);
    expect(undo).toMatch(/It does not take back what a generation or an upload put in a node/);
    expect(undo).toMatch(/a focus crop \(press the X on its chip\)/);
    expect(undo).toMatch(/Closing the space's tab clears its undo steps/);
  });

  it("says a slot holding a sound gets a border that stands out more, and removing a connection removes its mentions", () => {
    expect(section("Source slots")).toMatch(/holding a sound, or a video without a cover, keeps its icon and name and its border stands out more/);
    expect(section("Source slots")).not.toMatch(/coloured/);
    expect(section("Connections")).toMatch(/Removing a connection also removes every mention of that node from the prompt/);
  });

  it("says some models need a mention and cap how many", () => {
    const mentions = section("Mentions");
    expect(mentions).toMatch(/Some models need at least one connected node mentioned before they run/);
    expect(mentions).toMatch(/A mentioned text node sends its words as they are when the run starts/);
  });

  it("says brackets left in a prompt are sent", () => {
    expect(section("Proposal cards")).toMatch(/Whatever is left in a prompt is sent as it is, brackets included/);
  });

  it("says what the read-only notice counts and what the leave prompt covers", () => {
    const wrong = section("When something is wrong");
    expect(wrong).toMatch(/every browser tab that has the space open counts, the reader's own included/);
    expect(wrong).toMatch(/Closing or reloading the browser tab, including by the reload buttons above, shows the browser's own prompt/);
    expect(wrong).toMatch(/With a document open, "[^"]+" also shows for a moment; nothing typed after it is saved/);
    expect(wrong).toMatch(/until they upgrade/);
    expect(wrong).toMatch(/press Cmd\/Ctrl\+A twice, then Cmd\/Ctrl\+C, to copy it out before signing in again or reloading/);
    expect(wrong).toMatch(/as many open editing connections as the plan of the studio's admin allows \(only their upgrade raises it\)/);
  });

  it("says where credits are bought and that only the studio's admin assigns them", () => {
    const chat = section("The chat panel");
    expect(chat).toContain(`"${t("studio.topBar.credits")}" then "${t("credits.section.buy")}"`);
    expect(chat).toMatch(/only the studio's admin can assign them to this studio, so anyone else asks the admin/);
  });

  it("says a note's replies are posted with Save or Enter and deleting the note takes its replies", () => {
    const notes = section("Notes");
    expect(notes).toMatch(/or Enter posts it/);
    expect(notes).toMatch(/on the note itself removes the whole note with every reply/);
  });

  it("says nodes and notes are moved by dragging", () => {
    expect(section("Moving around the canvas")).toMatch(/Drag a node, a group or a note to move it/);
  });

  it("says the camera switch starts off and gates the wheels", () => {
    expect(section("Inside the generation panel")).toMatch(/the wheels only apply while the switch reads/);
  });

  it("puts the camera in the picture panel's settings popover, not on the bottom row (#2254)", () => {
    const panel = section("Inside the generation panel");
    expect(panel).not.toMatch(/camera icon/);
    expect(panel).toContain(`a row named ${'"'}${t("canvas.generatePanel.camera")}${'"'}`);
  });
});
