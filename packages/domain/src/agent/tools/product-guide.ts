// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Product guide tool — how the reader operates our product (#260).
 *
 * The one place that says where to click. The model cannot see the reader's
 * screen, and before this it guessed. Two kinds of fact live here:
 *
 * - What a rule the canvas enforces already says is read off that rule --
 *   which nodes generate, what connects into what -- so it moves with it.
 * - Every control with words on it is named by the message the reader's screen
 *   shows, in the locale the request pinned. Each message id is spelled out in
 *   the call itself, which is the form the missing-key check reads.
 *
 * The rest -- gestures, positions, icon-only controls, shortcuts -- is written
 * here and moves when the interface moves, the way a help page does.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { canConnect, canGenerate, t, type NodeType } from "@breatic/shared";

const inputSchema = z.object({}).strict();

/** The node types a reader can create, in the order the create menus list them. */
const CREATABLE: readonly NodeType[] = ["text", "image", "video", "audio"];

/**
 * A message as the reader's screen shows it, quoted.
 * @param message - The message, already translated.
 * @returns The message between double quotes.
 */
function quoted(message: string): string {
  return `"${message}"`;
}

/**
 * The line naming the node types that generate.
 * @returns One sentence listing them.
 */
function generatingLine(): string {
  return `Nodes that generate: ${CREATABLE.filter((type) => canGenerate(type)).join(", ")}.`;
}

/**
 * What may connect into each node type, one line per target.
 * @returns The lines, each naming a target and its allowed sources.
 */
function connectionLines(): string[] {
  return CREATABLE.map((target) => {
    const from = CREATABLE.filter((source) => canConnect(source, target));
    return `- into ${target}: ${from.join(", ")}`;
  });
}

/**
 * The guide, in the locale the current request pinned.
 * @returns The whole guide as the model reads it.
 */
export function renderProductGuide(): string {
  return [
    "## Spaces",
    "A project holds spaces, shown as tabs along the top. The + button at the right end of the tabs " +
      `opens a dialog: pick ${quoted(t("spaces.kind.canvas"))} or ${quoted(t("spaces.kind.document"))} ` +
      `(Canvas is the one selected when it opens), type a name and press ${quoted(t("spaces.create.submit"))}. ` +
      "This chat panel sits beside whichever space is open.",
    "",
    "## Making nodes",
    `- Right-click an empty spot on the canvas and pick ${quoted(t("canvas.handle.nodeText"))}, ` +
      `${quoted(t("canvas.handle.nodeImage"))}, ${quoted(t("canvas.handle.nodeVideo"))} or ` +
      `${quoted(t("canvas.handle.nodeAudio"))}; the node appears where you clicked.`,
    `- Or open ${quoted(t("menu.item.nodes"))} in the floating menu along the left edge and pick a type; ` +
      "the node appears in the middle of the view.",
    `- Drop files onto the canvas, or use ${quoted(t("menu.item.upload"))} in the same menu: pictures, ` +
      "videos and sounds become nodes of their kind, any other file becomes a text node.",
    "- Paste with Cmd/Ctrl+V: a copied node, a file or screenshot, or plain text, which becomes a text node.",
    "- Double-clicking empty canvas does nothing.",
    "",
    "## Filling a node",
    `An empty picture, video or sound node shows ${quoted(t("canvas.nodePlaceholder.image"))}: double-click it ` +
      `to pick a file. An empty text node shows ${quoted(t("canvas.nodePlaceholder.text"))}. To replace what a ` +
      `node holds, right-click it and choose ${quoted(t("canvas.nodeMenu.upload"))}.`,
    "",
    "## Generating",
    generatingLine(),
    `Right-click the node and choose ${quoted(t("canvas.nodeMenu.generate"))}: the generation panel opens just ` +
      "below the node. Clicking a node only selects it, and the panel closes once the node is no longer " +
      "selected. Write the prompt, then press the round button with an upward arrow at the bottom-right of the " +
      "panel. The result replaces what the node held. A small count at the node's top-right shows the task " +
      "running, done or failed; clicking it lists the tasks.",
    "",
    "## Inside the generation panel",
    "The top row holds the tool buttons, with an X at the far right that closes the panel. Below it sit the " +
      "references attached to this node (only when there are some) and the prompt. The bottom row, left to " +
      "right: mode, model, parameters, the credit estimate and the arrow button. Mode names are in English on " +
      "every screen; the mode decides which slots and parameters show.",
    `- Picture panel: tools ${quoted(t("canvas.generatePanel.reference"))}, ` +
      `${quoted(t("canvas.generatePanel.focus"))}, and ${quoted(t("canvas.generatePanel.style"))} when the model ` +
      `takes a style picture. Parameters sit in one pill (${quoted(t("canvas.generatePanel.imageParams"))} ` +
      "until set): ratio and resolution. A camera button, an icon only, appears when the model has camera settings.",
    `- Video panel: tools ${quoted(t("canvas.generatePanel.reference"))}, ` +
      `${quoted(t("canvas.generatePanel.focus"))} and the source slots of the current mode. The parameters pill ` +
      `(${quoted(t("canvas.generatePanel.videoParams"))} until set) holds ratio, resolution, duration and ` +
      "whether to generate sound.",
    `- Sound panel: tool ${quoted(t("canvas.generatePanel.reference"))} and the source slots of the current mode. ` +
      `The ${quoted(t("canvas.generatePanel.audioSettings"))} pill holds the voice and its sliders.`,
    "",
    "## Source slots",
    "Modes that need one particular source -- a first frame, an end frame, a character picture, a driving " +
      "video, a voice sample, a song -- show one button per slot in the tool row. Press the slot's button, then " +
      "click a node on the canvas: only nodes that fit stay lit. The node's content is copied into the slot and " +
      "picking ends. Press the slot again to pick another; the X on the slot empties it. A required slot left " +
      "empty stops the run with a message naming it, while the arrow button stays active. A slot holds a copy " +
      "and needs no connection or mention.",
    "",
    "## Connections",
    "Drag from the dot on a node's right edge to another node's left edge. A connection offers the first " +
      "node to the second as reference material. What may connect into each node:",
    ...connectionLines(),
    `In a generation panel, ${quoted(t("canvas.generatePanel.reference"))} lets you click nodes on the canvas ` +
      `to connect them; ${quoted(t("canvas.generatePanel.exitSelect"))} or Esc stops. To remove a connection, ` +
      "select it and press the scissors at its middle, or right-click it and choose " +
      `${quoted(t("canvas.edge.delete"))}.`,
    "",
    "## Mentions",
    "A node connected into this one is offered but not sent until the prompt mentions it. In the prompt, type " +
      "@ and choose the node from the list that opens; only nodes connected into this one are listed. Clicking " +
      "a row in the strip of references above the prompt inserts it too. Typing the name does not mention it.",
    "",
    "## Groups and undo",
    "Drag a box across empty canvas to select several nodes; the bar above them offers " +
      `${quoted(t("canvas.group.group"))}, or press Cmd/Ctrl+G (Cmd/Ctrl+Shift+G to ` +
      `${quoted(t("canvas.group.ungroup"))}). Undo is Cmd/Ctrl+Z, redo Cmd/Ctrl+Shift+Z. Scroll to pan; pinch ` +
      "or hold Ctrl and scroll to zoom.",
    "",
    "## Proposal cards",
    `A proposal you make appears in this chat as a card. Pressing ${quoted(t("chat.proposal.use"))} places its ` +
      "nodes near the middle of the reader's view, wired and grouped, as one step undo reverses. A canvas has " +
      `to be open: anywhere else the card only says ${quoted(t("chat.proposal.needCanvas"))} With one ` +
      "generating node its panel opens by itself; with several, the reader right-clicks each and chooses " +
      `${quoted(t("canvas.nodeMenu.generate"))}. An empty node in the proposal is for the reader's own ` +
      "material: they double-click it and pick a file.",
    "",
    "## Document spaces",
    "- Markdown at the start of a line: `# `, `## `, `### ` for headings; `1. ` numbered list; `- ` " +
      "bulleted list; `[ ] ` to-do; three backticks for a code block; `> ` quote.",
    "- Shortcuts, Cmd on a Mac and Ctrl elsewhere: Cmd+Alt+0 plain text, Cmd+Alt+1/2/3 headings, " +
      "Cmd+Shift+8 bulleted list, Cmd+Shift+7 numbered list, Cmd+Shift+9 to-do, Cmd+Alt+C code block, " +
      "Cmd+Shift+B quote; Cmd+B bold, Cmd+I italic, Cmd+U underline, Cmd+Shift+S strikethrough, Cmd+E " +
      "inline code.",
    "- Selecting text shows a bar of icon buttons: block type, alignment, bold, italic, strikethrough, " +
      "underline, link, inline code, and colour (shown as the letter A).",
    "- Hovering a line shows a handle at its left. Drag it to move the block; click it for a menu with " +
      `${quoted(t("spaces.document.blockHandle.duplicate"))}, ${quoted(t("spaces.document.blockHandle.insertBelow"))}, ` +
      `${quoted(t("spaces.document.blockHandle.delete"))}, block type, alignment and colour.`,
    "- There is no slash menu. Not available yet: comments, snapshots, images or other media in a document, " +
      "and the AI menu on the selection bar, which looks active but does nothing.",
  ].join("\n");
}

export const productGuide: Tool<z.infer<typeof inputSchema>, string> = tool({
  description:
    "How the reader operates our product, canvas and document spaces: making, filling and connecting nodes, " +
    "opening the generation panel and what is in it, source slots, mentions, groups, placing a proposal card, " +
    "and writing in a document. Read it before telling the reader how to do something here: you cannot see " +
    "their screen. Describe only what it says. Name a control with words on it by the quoted name it gives, " +
    "which is what the reader's screen shows; describe an icon-only control the way it describes it.",
  inputSchema,
  metadata: { runningLine: "chat.tool.readingGuide" },
  execute: async (
    _input: z.infer<typeof inputSchema>,
    // Unused: builds text and returns, so there is nothing to abandon.
    // Declared so every tool has the same shape.
    _options: { abortSignal?: AbortSignal },
  ): Promise<string> => renderProductGuide(),
});
