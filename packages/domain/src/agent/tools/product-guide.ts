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
export const CREATABLE = ["text", "image", "audio", "video"] as const satisfies readonly NodeType[];

type Creatable = (typeof CREATABLE)[number];

/**
 * A message as the reader's screen shows it, quoted.
 * @param message - The message, already translated.
 * @returns The message between double quotes.
 */
function quoted(message: string): string {
  return `"${message}"`;
}

/**
 * The name a node type goes by in the create menus, quoted.
 * @param type - A creatable node type.
 * @returns Its menu label, quoted.
 */
function typeLabel(type: Creatable): string {
  switch (type) {
    case "text":
      return quoted(t("canvas.handle.nodeText"));
    case "image":
      return quoted(t("canvas.handle.nodeImage"));
    case "audio":
      return quoted(t("canvas.handle.nodeAudio"));
    case "video":
      return quoted(t("canvas.handle.nodeVideo"));
  }
}

/**
 * The line naming the node types that generate.
 * @returns One sentence listing them.
 */
function generatingLine(): string {
  return `Nodes that generate: ${CREATABLE.filter((type) => canGenerate(type)).map(typeLabel).join(", ")}.`;
}

/**
 * What may connect into each node type, one line per target.
 * @returns The lines, each naming a target and its allowed sources.
 */
function connectionLines(): string[] {
  return CREATABLE.map((target) => {
    const from = CREATABLE.filter((source) => canConnect(source, target));
    return `- into ${typeLabel(target)}: ${from.map(typeLabel).join(", ")}`;
  });
}

/**
 * The guide, in the locale the current request pinned.
 *
 * Every quoted name is text the reader's screen shows: a menu row, words on a
 * button, or a tooltip that appears on hover. A control whose name lives only
 * in its accessible label is described by how it looks.
 * @returns The whole guide as the model reads it.
 */
export function renderProductGuide(): string {
  return [
    "## Spaces",
    "A project holds spaces, shown as tabs along the top. To the right of the tabs, past a thin divider, is a " +
      "small group of icon buttons; the first, a plus sign, opens a dialog for a new space (people who can only " +
      `view the project do not see it). In the dialog pick the ${quoted(t("spaces.kind.canvas"))} or ` +
      `${quoted(t("spaces.kind.document"))} card (${quoted(t("spaces.kind.canvas"))} is selected when it opens; ` +
      `a third, greyed card is not available yet), type a name and press ${quoted(t("spaces.create.submit"))}, ` +
      "which stays greyed until there is a name. This chat panel sits to the left of whichever space is open " +
      "and can be collapsed.",
    "",
    "## Making nodes",
    `- Right-click an empty spot on the canvas and pick ${typeLabel("text")}, ${typeLabel("image")}, ` +
      `${typeLabel("audio")} or ${typeLabel("video")}; the node appears centred where you clicked. The same menu ` +
      "also offers to paste what you copied.",
    "- On a canvas space a floating menu of icons runs along the left edge; each names itself when hovered. " +
      `${quoted(t("menu.item.nodes"))} (a sparkle) opens a list of the same types; the node appears in the ` +
      "middle of the view.",
    `- Drop files onto the canvas, or use ${quoted(t("menu.item.upload"))} (an arrow pointing up out of a tray) ` +
      "in that menu. Pictures, videos and sounds in a supported format become nodes of their kind. Any other file " +
      "becomes a text node holding its text: plain text, PDF, Word and Excel files work, other kinds show an error " +
      "in the node. An empty file, an unsupported format or a file over the size limit makes no node and a message " +
      "names it. Several files at once arrive side by side inside a new group.",
    "- Drag from the dot on a node's right edge and let go on empty canvas: a menu lists the types that can take " +
      "that connection, and the one you pick appears there, already connected.",
    "- Paste with Cmd/Ctrl+V: a copied node, a file or screenshot, or plain text, which becomes a text node.",
    `- Double-clicking empty canvas does nothing. An empty canvas shows ${quoted(t("canvas.emptyState.title"))} ` +
      "in the middle.",
    "",
    "## Filling a node",
    `An empty picture, video or sound node shows its type icon, ${quoted(t("canvas.nodePlaceholder.image"))} and, ` +
      `in smaller text, ${quoted(t("canvas.nodePlaceholder.rightClickHint"))}: double-click it to pick a file. An ` +
      `empty text node shows ${quoted(t("canvas.nodePlaceholder.text"))}; double-clicking it lets you type. To ` +
      `replace what a node holds, right-click it and choose ${quoted(t("canvas.nodeMenu.upload"))}: a picture, ` +
      "video or sound node takes a new file of its kind, a text node takes the text of a document. Earlier " +
      "pictures, videos and sounds a node held stay listed under its history on the same menu.",
    "",
    "## Generating",
    generatingLine(),
    `Right-click such a node and choose ${quoted(t("canvas.nodeMenu.generate"))} (on a text node that row is ` +
      "greyed): the generation panel opens just below the node. Clicking a node only selects it. The panel closes " +
      "with the X at its top-right, or when the node stops being selected, except while you are picking nodes for " +
      "it, when clicking other nodes keeps it open. Write the prompt, then press the round button with an upward " +
      "arrow at the right end of the panel's bottom row. The result replaces what the node held.",
    "A small column of icons appears just past the node's right edge, level with its top, one icon for each " +
      "state that has tasks, uploads included: a spinning circle (running), a circle with a tick (done), a circle " +
      "with an X (failed), a clock (expired). Hovering one shows how many; clicking it lists them. Zoomed far out, " +
      "only the spinning one remains.",
    "",
    "## Inside the generation panel",
    "The top row holds the tool buttons, each an icon over its name, with an X at the far right that closes the " +
      "panel. Below it, only when there are some, is a strip of chips: one for each node connected into this one " +
      "and one for each focus crop. A chip shows a thumbnail or type icon, the source node's name (a focus crop " +
      "adds a crop icon before the name) and a small X that removes it; a chip the current mode or model cannot " +
      "use is faded. Then the prompt box; some music models add a second box for lyrics under it.",
    "The bottom row, left to right: the mode, named in English on every screen (for example Text to Image); the " +
      "model's name; a pill showing the current settings (for example 1k · 1:1 · Medium); on the picture panel, a " +
      "camera icon when the model has camera settings; then at the right end the credit estimate and the round " +
      "button with an upward arrow. A model with no settings shows no pill. The mode decides which models are " +
      "offered; mode and model together decide which slot buttons and settings show.",
    `- Picture panel: tools ${quoted(t("canvas.generatePanel.reference"))}, ` +
      `${quoted(t("canvas.generatePanel.focus"))}, and ${quoted(t("canvas.generatePanel.style"))} when the model ` +
      "takes a style picture. Clicking the settings pill opens resolution, ratio and any settings of the model's " +
      "own, such as quality.",
    `- Video panel: tools ${quoted(t("canvas.generatePanel.reference"))} and ` +
      `${quoted(t("canvas.generatePanel.focus"))}, then after a thin divider one button for each source slot. The ` +
      "settings pill shows values such as 16:9 · 720p · 8s; clicking it opens ratio, resolution, duration, a " +
      "switch to generate sound on models that can, and any settings of the model's own. A setting the model does " +
      "not have is left out.",
    `- Sound panel: tool ${quoted(t("canvas.generatePanel.reference"))}, then the source slots. The settings pill ` +
      "shows a speaker icon and the current voice and settings, for example Alex · 1.00x, or " +
      `${quoted(t("canvas.generatePanel.voicePlaceholder"))} until a voice is picked. Clicking it opens the voice ` +
      "list with a search box, sliders such as speed, volume, stability and similarity when the model has them, on " +
      "some models a choice between a single voice and a dialogue, and any settings of the model's own.",
    "",
    "## Source slots",
    "Some modes and models need one particular source and show a button for each, after the divider, an icon " +
      `over its name: for example ${quoted(t("canvas.generatePanel.firstFrame"))}, ` +
      `${quoted(t("canvas.generatePanel.endFrame"))}, ${quoted(t("canvas.generatePanel.characterImage"))}, ` +
      `${quoted(t("canvas.generatePanel.drivingVideo"))}, ${quoted(t("canvas.generatePanel.drivingAudio"))}, ` +
      `${quoted(t("canvas.generatePanel.refAudio"))}, ${quoted(t("canvas.generatePanel.musicSong"))}, or on the ` +
      `picture panel ${quoted(t("canvas.generatePanel.style"))}. Press a slot's button, then click a node on the ` +
      "canvas: only nodes that fit stay lit. The node's content is copied into the slot, a filled picture slot " +
      "shows that picture in place of its name, and picking ends. To " +
      "replace it, press the filled slot and click another node. Pressing the slot again while picking, Esc, or " +
      `${quoted(t("canvas.generatePanel.exitSelect"))} in the bar at the top stops picking without a change. The X ` +
      "on a filled slot empties it. A required slot left empty stops the run with a message naming it, while the " +
      "arrow button stays active. A slot holds a copy and needs no connection or mention.",
    "",
    "## Connections",
    "Nodes show a small dot on their left and right edges. Drag from a node's right dot to another node's left " +
      "dot; the connection offers the first node to the second as reference material. A pair that is not allowed " +
      "snaps back with a message. What may connect into each node:",
    ...connectionLines(),
    `In a generation panel, ${quoted(t("canvas.generatePanel.reference"))} lets you click nodes on the canvas ` +
      `to connect them; ${quoted(t("canvas.generatePanel.exitSelect"))} in the bar at the top, Esc, or pressing ` +
      `${quoted(t("canvas.generatePanel.reference"))} again stops. To remove a connection, select it and press the ` +
      `scissors at its middle, or right-click it and choose ${quoted(t("canvas.edge.delete"))}.`,
    "",
    "## Focus crops",
    `In a picture or video panel, ${quoted(t("canvas.generatePanel.focus"))} takes a region of a picture or ` +
      "video node as a reference: press it, click a node on the canvas, and drag a box over the part you want. A " +
      `bar under the node offers fixed ratios for the box, ${quoted(t("canvas.generatePanel.focusCancel"))} and ` +
      `${quoted(t("canvas.generatePanel.focusConfirm"))}; for a video, first drag its timeline in that bar to ` +
      `choose the frame. After ${quoted(t("canvas.generatePanel.focusConfirm"))}, the crop joins the strip above ` +
      "the prompt as a chip with a crop icon before the source node's name. It is a copy: it needs no connection, " +
      "and it stays if the source node changes.",
    "",
    "## Mentions",
    "Connected nodes and focus crops are offered but not sent until the prompt mentions them. In the prompt, type " +
      "@ and choose from the list that opens: it holds the nodes connected into this one and this node's focus " +
      "crops, less any the current mode and model cannot take. Letters typed after @ narrow the list, which shows " +
      "up to eight rows; only choosing a row makes a mention, and typing the name alone does not. Clicking a chip " +
      "in the strip above the prompt inserts it too; a faded chip shows a message saying why instead.",
    "",
    "## Groups and undo",
    "Drag on empty canvas to draw a box; nodes fully inside it are selected. With two or more loose nodes " +
      `selected, a small bar above them shows ${quoted(t("canvas.group.group"))} (right-clicking the selection ` +
      "offers it too), or press Cmd/Ctrl+G. With a group selected, the bar shows a colour swatch for its " +
      `background and ${quoted(t("canvas.group.ungroup"))}, or press Cmd/Ctrl+Shift+G. Undo is Cmd/Ctrl+Z; redo ` +
      "is Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y; buttons for both sit at the bottom right. Scroll to pan; pinch or hold " +
      "Ctrl and scroll to zoom.",
    "",
    "## Proposal cards",
    "A proposal you make appears in this chat as a card: a one-line summary, the nodes as chips joined by arrows " +
      "in the order they run (empty nodes drawn dashed), any finished text in full, the credit estimate and time, " +
      `and a ${quoted(t("chat.proposal.use"))} button. Under each node it lists what is left for the reader, and ` +
      `for each generating node it ends with ${quoted(t("chat.proposal.promptReady"))}, or ` +
      `${quoted(t("chat.proposal.settingsReady"))} where the model has no prompt box.`,
    `Pressing ${quoted(t("chat.proposal.use"))} places the nodes near the middle of the reader's view, wired ` +
      "together and grouped when there are two or more, as one step undo reverses. A canvas has to be open: " +
      `anywhere else pressing it shows the message ${quoted(t("chat.proposal.needCanvas"))} and places nothing. ` +
      "With one generating node its panel opens by itself; with several, the group is selected and the reader " +
      `right-clicks each node and chooses ${quoted(t("canvas.nodeMenu.generate"))}.`,
    "Each generating node arrives empty, with its mode and model set and, when the model has a prompt box, its " +
      `prompt written; otherwise the panel shows ${quoted(t("canvas.generatePanel.promptNotUsed"))}. The reader ` +
      "generates the nodes in the order the card's arrows run, each before the node it feeds.",
    "Spots left for the reader are in square brackets, in a prompt or in a finished text node's words. A ✏️ spot " +
      "is a phrase to replace with their own words, or a setting to pick in the panel. A 📎 spot is material only " +
      "the reader has; it usually goes in an empty node the proposal placed, which they double-click to pick a file.",
    "How work reaches a node depends on where it goes:",
    "- Into the reference list: the prompt mentions it where the proposal points at it, and a 📎 spot already " +
      "mentions its empty node.",
    "- Into one of the mode's source slots: it is not mentioned, and the card gives no line for picking it. Once " +
      "that node holds its file or its generated result, the reader opens the panel of the node it feeds, presses " +
      "that slot's button and clicks the node.",
    "",
    "## Document spaces",
    "- Markdown at the start of a line: `# `, `## `, `### ` for headings; a number, a full stop and a space " +
      "(`1. `) for an ordered list; `- `, `* ` or `+ ` for a bullet list; `[ ] ` for a to-do (`[x] ` ticked); " +
      "three backticks then a space for a code block; `> ` for a quote.",
    "- Shortcuts, Cmd and Option on a Mac, Ctrl and Alt elsewhere: Cmd+Alt+0 plain text, Cmd+Alt+1/2/3 headings, " +
      "Cmd+Shift+8 bullet list, Cmd+Shift+7 ordered list, Cmd+Shift+9 to-do, Cmd+Alt+C code block, Cmd+Shift+B " +
      "quote; pressing the shortcut of the type a block already has turns it back to plain text. Cmd+B bold, Cmd+I " +
      "italic, Cmd+U underline, Cmd+Shift+S strikethrough, Cmd+E inline code.",
    "- Selecting text shows a bar, left to right: an icon of the current block type with a small arrow, an " +
      "alignment icon with an arrow, bold B, italic I, strikethrough S and underline U icons, a link icon, a code " +
      "icon, the letter A with an arrow (colour), a speech-bubble icon (comment), and a sparkle with the word " +
      `${quoted(t("spaces.document.commands.ai"))} and an arrow. The other buttons show no name on hover. Hovering ` +
      "the block type, alignment, colour or AI button opens its menu. Hovering the speech bubble shows " +
      `${quoted(t("spaces.document.commands.comment"))} marked not open yet. The AI menu's commands look ` +
      "available but do nothing yet.",
    "- Hovering a line shows a handle at its left. Drag it to move the block; click it for a menu with " +
      `${quoted(t("spaces.document.commands.blockType"))}, ${quoted(t("spaces.document.blockHandle.duplicate"))}, ` +
      `${quoted(t("spaces.document.blockHandle.insertBelow"))}, ${quoted(t("spaces.document.commands.align"))}, ` +
      `${quoted(t("spaces.document.commands.color"))}, ${quoted(t("spaces.document.commands.comment"))} (marked ` +
      `not open yet) and ${quoted(t("spaces.document.blockHandle.delete"))}.`,
    "- There is no slash menu. Not available yet: comments, the AI commands, snapshots, images or other media, " +
      "tables, dividers, toggle lists, and headings below level 3.",
  ].join("\n");
}

export const productGuide: Tool<z.infer<typeof inputSchema>, string> = tool({
  description:
    "How the reader operates our product, canvas and document spaces: making, filling and connecting nodes, " +
    "opening the generation panel and what is in it, source slots, focus crops, mentions, groups, placing a proposal card, " +
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
