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
    "A project holds spaces, shown as tabs along the top; each tab shows a type icon and the space's name, and " +
      "hovering a tab shows its full name. Click a tab to switch to it. Double-click the name to rename it: Enter " +
      "or clicking away keeps the new name, Esc keeps the old one. A locked space shows a small padlock after its " +
      `name, and trying to rename it shows ${quoted(t("spaces.rename.locked"))} Hovering a tab also shows a small ` +
      "X at its right end, which closes the tab; the space stays in the project. While an upload in that space " +
      `is still running, closing it shows ${quoted(t("canvas.close.operationInProgress"))} Drag a tab sideways to reorder ` +
      "the tabs. When the tabs do not fit, arrows at either end scroll them, and a crosshair button just right of " +
      "the tabs scrolls the current tab back into view.",
    "To the right of the tabs, past a thin divider, are three icon buttons. The first, a plus sign, opens a " +
      "dialog for a new space (people who can only view the project do not see it). In the dialog pick the " +
      `${quoted(t("spaces.kind.canvas"))} or ${quoted(t("spaces.kind.document"))} card ` +
      `(${quoted(t("spaces.kind.canvas"))} is selected when it opens; a third, greyed card is not available yet), ` +
      `type a name and press ${quoted(t("spaces.create.submit"))}, which stays greyed until there is a name.`,
    "The second, three lines with the number of spaces beside them, opens " +
      `${quoted(t("spaces.drawer.title"))}: every space in the project, newest first, each with its type icon, ` +
      `name and when it was made; the one open now is marked ${quoted(t("spaces.drawer.status.editing"))} and ` +
      `others open as tabs ${quoted(t("spaces.drawer.status.open"))}. Clicking a row opens that space as a tab. ` +
      `Hovering a row shows three icons: an eye (${quoted(t("spaces.drawer.action.view"))}), a padlock ` +
      `(${quoted(t("spaces.drawer.action.lock"))} or ${quoted(t("spaces.drawer.action.unlock"))}) and a bin ` +
      `(${quoted(t("spaces.drawer.action.delete"))}), which asks before deleting. The bin is greyed on a locked ` +
      `space (${quoted(t("spaces.drawer.action.deleteLocked"))}) and on the project's only space ` +
      `(${quoted(t("spaces.drawer.action.deleteLastSpace"))}). The eye on a space that is not open as a tab ` +
      "opens a read-only panel that does not show the space's content yet; open the space itself to see it.",
    `The third, a pulse line, opens ${quoted(t("activity.header"))}: the project's uploads, generations and ` +
      "changes to spaces and members. The project's owner sees " +
      `${quoted(t("activity.action.restore"))} on a deleted space's entry, which brings the space back.`,
    `With every tab closed, the space area shows ${quoted(t("project.space.noActive"))}`,
    "",
    "## The chat panel",
    "This chat panel sits to the left of whichever space is open. The first button at the far left of the tab " +
      "bar, a panel icon, hides or shows it; dragging the line between it and the space makes it wider or " +
      "narrower. At its top, left to right: two speech bubbles, which open " +
      `${quoted(t("chat.history.title"))}, the earlier conversations, most recently used first; the ` +
      `conversation's name, ${quoted(t("chat.conversation.untitled"))} until it has one, which double-clicking ` +
      "renames; and a plus sign, which starts a new conversation. In the list, click a conversation to switch to " +
      "it; hovering one shows three dots with " +
      `${quoted(t("chat.conversation.rename"))} and ${quoted(t("chat.conversation.delete"))}, which asks first.`,
    "The plus sign under the left end of the message box attaches files to the next message. Canvas nodes are " +
      `handed to the chat with ${quoted(t("canvas.contextMenu.addToAgent"))} on their right-click menu; they ` +
      "appear as a chip above the message box and go with the next message.",
    "",
    "## Making nodes",
    `- Right-click an empty spot on the canvas and pick ${typeLabel("text")}, ${typeLabel("image")}, ` +
      `${typeLabel("audio")} or ${typeLabel("video")}; the node appears centred where you clicked. The same menu ` +
      `has ${quoted(t("canvas.contextMenu.paste"))}, which puts what you copied at the spot you clicked.`,
    "- On a canvas space a floating menu of icons runs along the left edge; each names itself when hovered. " +
      `${quoted(t("menu.item.nodes"))} (a sparkle) opens a list of the same types; the node appears in the ` +
      "middle of the view.",
    "- Drop files onto the canvas, or paste one. Pictures, videos and sounds become nodes of their kind; one in " +
      "a format that is not supported makes no node, and a message names it. Any other file becomes a text node " +
      "holding its text: plain text, PDF, Word and Excel files work, other kinds show an error in the node. An " +
      "empty file or one over the size limit makes no node, and a message names it. Several files at once arrive " +
      "side by side inside a new group.",
    `- ${quoted(t("menu.item.upload"))} (an arrow pointing up out of a tray) in that menu opens a file picker ` +
      "that lists pictures, videos, sounds and plain text files; PDF, Word and Excel files go in by dropping or " +
      "pasting them. What you pick arrives the same way as dropped files.",
    "- Drag from the dot on a node's right edge and let go on empty canvas: a menu lists the types that can take " +
      "that connection, and the one you pick appears there, already connected.",
    "- Paste with Cmd/Ctrl+V: a copied node, a file or screenshot, or plain text, which becomes a text node.",
    `- Double-clicking empty canvas does nothing. An empty canvas shows ${quoted(t("canvas.emptyState.title"))} ` +
      "in the middle.",
    "",
    "## Filling a node",
    `An empty picture, video or sound node shows its type icon, ${quoted(t("canvas.nodePlaceholder.image"))} and, ` +
      `in smaller text, ${quoted(t("canvas.nodePlaceholder.rightClickHint"))}: double-click it to pick a file. An ` +
      `empty text node shows its icon, ${quoted(t("canvas.nodePlaceholder.text"))} and the same smaller line; ` +
      "double-clicking it lets you type. To replace what a node holds, right-click it and choose " +
      `${quoted(t("canvas.nodeMenu.upload"))}: a picture, video or sound node takes a new file of its kind, a ` +
      "text node takes the text of a plain text, PDF, Word or Excel file.",
    "Every node shows its name just above its top-left corner, after a type icon; a new node is named after its " +
      "type. Double-click the name to rename it. A group's name sits at its top-left and renames the same way.",
    "",
    "## Node menus",
    "Right-clicking a node opens its menu; people who can only view the project get none. On a picture, video, " +
      "sound or text node the rows are, top to bottom:",
    `- ${quoted(t("canvas.nodeMenu.generate"))} (greyed on a text node) and ` +
      `${quoted(t("canvas.nodeMenu.upload"))}.`,
    `- On a picture node, ${quoted(t("canvas.nodeMenu.resetEmpty"))}: a panel under the node, headed ` +
      `${quoted(t("canvas.emptyImage.title"))}, takes a ratio or a width and height and a colour; the round button ` +
      "with an upward arrow replaces the picture with a blank one of that size and colour, and the X closes the " +
      "panel without a change.",
    `- ${quoted(t("canvas.nodeMenu.history"))}: a panel listing what the node has held, each marked ` +
      `${quoted(t("canvas.history.typeGeneration"))}, ${quoted(t("canvas.history.typeUpload"))} or ` +
      `${quoted(t("canvas.history.typeSnapshot"))}, the one it holds now marked ` +
      `${quoted(t("canvas.history.current"))}; ${quoted(t("canvas.history.restore"))} puts an earlier one back.`,
    `- On a text node, ${quoted(t("canvas.nodeMenu.snapshot"))}, greyed while the node is empty: it keeps a copy ` +
      `of the node's words in its history and shows ${quoted(t("canvas.history.snapshotKept"))}.`,
    `- On a picture, video or sound node, ${quoted(t("canvas.nodeMenu.download"))}, which saves the file, then ` +
      `${quoted(t("canvas.nodeMenu.understand"))}, which writes a description of what the node holds into a new ` +
      `text node connected to it, and ${quoted(t("canvas.nodeMenu.tools"))}, ` +
      `which is always greyed: it is not open yet. ${quoted(t("canvas.nodeMenu.download"))} and ` +
      `${quoted(t("canvas.nodeMenu.understand"))} are greyed while the node holds nothing.`,
    `- ${quoted(t("canvas.contextMenu.copy"))} (Cmd/Ctrl+C) and ${quoted(t("canvas.contextMenu.duplicate"))} ` +
      "(Cmd/Ctrl+D), which places a copy slightly below and to the right.",
    `- ${quoted(t("canvas.contextMenu.rename"))} and ${quoted(t("canvas.nodeMenu.lock"))} or ` +
      `${quoted(t("canvas.nodeMenu.unlock"))}. A locked node shows a small padlock at its top-right corner and ` +
      `has no ${quoted(t("canvas.contextMenu.rename"))} row; moving, renaming, deleting, filling or generating ` +
      `into it shows ${quoted(t("canvas.gate.locked"))} Its generation panel still opens.`,
    `- ${quoted(t("canvas.contextMenu.addToAgent"))}, then ${quoted(t("canvas.contextMenu.deleteNode"))} ` +
      "(Backspace or Delete). A node with tasks still running is not deleted: " +
      `${quoted(t("canvas.gate.handling"))}`,
    `A group's menu has ${quoted(t("canvas.contextMenu.copy"))}, ${quoted(t("canvas.contextMenu.duplicate"))}, ` +
      `${quoted(t("canvas.group.ungroup"))}, ${quoted(t("canvas.contextMenu.rename"))}, ` +
      `${quoted(t("canvas.group.lock"))} or ${quoted(t("canvas.group.unlock"))}, ` +
      `${quoted(t("canvas.contextMenu.addToAgent"))} and ${quoted(t("canvas.contextMenu.deleteGroup"))}; a ` +
      `locked group has no ${quoted(t("canvas.group.ungroup"))} or ${quoted(t("canvas.contextMenu.rename"))}, ` +
      "and its members stay editable. Right-clicking one of several selected nodes opens " +
      `${quoted(t("canvas.group.group"))} (when none is in a group), ${quoted(t("canvas.contextMenu.copy"))}, ` +
      `${quoted(t("canvas.contextMenu.duplicate"))}, ${quoted(t("canvas.contextMenu.addToAgent"))} and ` +
      `${quoted(t("canvas.contextMenu.deleteSelection"))}. A note's menu has ` +
      `${quoted(t("canvas.nodeMenu.lock"))}, ${quoted(t("canvas.contextMenu.addToAgent"))} and ` +
      `${quoted(t("canvas.contextMenu.deleteNode"))}.`,
    "",
    "## Notes",
    `${quoted(t("menu.item.comment"))} (a speech bubble) in the left menu leaves a note on the canvas: press it, ` +
      "and the pointer turns into a speech bubble; click a spot and a small yellow box opens there with " +
      `${quoted(t("canvas.annotation.placeholder"))}. Shift+Enter starts a new line; Enter posts the note; Esc or ` +
      "clicking away drops it. Esc or a right-click before clicking a spot cancels. A posted note is a small " +
      "round bubble with its author's picture; clicking it opens the note, its replies and a " +
      `${quoted(t("canvas.annotation.replyPlaceholder"))} box. Each entry's three dots offer ` +
      `${quoted(t("canvas.annotation.edit"))} and ${quoted(t("canvas.annotation.delete"))} to whoever may change it; ` +
      `deleting someone else's note, unless you own the project, shows ${quoted(t("canvas.gate.notYours"))}`,
    "Below a thin line the left menu has three more icons, " +
      `${quoted(t("menu.item.collection"))}, ${quoted(t("menu.item.help"))} and ` +
      `${quoted(t("menu.item.feedback"))}, which do nothing yet. For people who can only view the project every ` +
      `icon there is greyed and hovering it shows ${quoted(t("menu.disabledTooltip"))}.`,
    "",
    "## Moving around the canvas",
    "At the bottom right of a canvas is a bar, left to right: " +
      `${quoted(t("viewportToolbar.undo"))} and ${quoted(t("viewportToolbar.redo"))} (curved arrows); ` +
      `${quoted(t("viewportToolbar.zoomOut"))} (a minus), the zoom percentage and ` +
      `${quoted(t("viewportToolbar.zoomIn"))} (a plus); ${quoted(t("viewportToolbar.fit"))} (four corner ` +
      "brackets), which frames every node; " +
      `${quoted(t("viewportToolbar.snap.label"))} (a grid, off at first) and ` +
      `${quoted(t("viewportToolbar.minimap.label"))} (on at first), each dark while on. Clicking the percentage ` +
      "lists 10% to 800% and has a box to type a percentage and press Enter. The minimap can be dragged to move " +
      "the view. The left menu and this bar slide out of sight while nodes are being picked for a panel.",
    "Scroll to pan, or hold Space and drag; pinch or hold Ctrl and scroll to zoom. Cmd/Ctrl with plus or minus " +
      "zooms the whole browser page, not the canvas. Click a node to select it; Cmd/Ctrl-click adds or removes " +
      "one. The arrow keys nudge the selected nodes. Cmd/Ctrl+A does not select every node. Backspace or Delete " +
      "removes the selected nodes and connections.",
    "",
    "## Generating",
    generatingLine(),
    `Right-click such a node and choose ${quoted(t("canvas.nodeMenu.generate"))} (on a text node that row is ` +
      "greyed): the generation panel opens just below the node. Clicking a node only selects it. The panel closes " +
      "with the X at its top-right, or when the node stops being selected, except while you are picking nodes for " +
      "it, when clicking other nodes keeps it open; Esc does not close it. Write the prompt, then press the round " +
      "button with an upward arrow at the right end of the panel's bottom row. The result replaces what the node " +
      "held.",
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
      "camera icon when the model has camera settings; then at the right end the credit estimate, a star with a " +
      "number, and the round button with an upward arrow. A model with no settings shows no pill.",
    "Clicking the mode lists the modes this node's type offers; picking one changes which models are offered. " +
      "Clicking the model's name lists the current mode's models, each with its maker's icon, its name and a line " +
      "saying what it is good at; picking one switches to it. Mode and model together decide which slot buttons " +
      "and settings show.",
    `- Picture panel: tools ${quoted(t("canvas.generatePanel.reference"))}, ` +
      `${quoted(t("canvas.generatePanel.focus"))}, and ${quoted(t("canvas.generatePanel.style"))} when the model ` +
      "takes a style picture. Clicking the settings pill opens resolution, ratio and any settings of the model's " +
      "own, such as quality. The camera icon opens a panel headed " +
      `${quoted(t("canvas.generatePanel.camera"))} with an on/off switch and wheels for ` +
      `${quoted(t("canvas.generatePanel.lens"))}, ${quoted(t("canvas.generatePanel.focalLength"))} and ` +
      `${quoted(t("canvas.generatePanel.aperture"))} as well as the camera itself.`,
    `- Video panel: tools ${quoted(t("canvas.generatePanel.reference"))} and ` +
      `${quoted(t("canvas.generatePanel.focus"))}, then after a thin divider one button for each source slot. The ` +
      "settings pill shows values such as 16:9 · 720p · 8s; clicking it opens ratio, resolution, duration, a " +
      "switch to generate sound on models that can, and any settings of the model's own. A setting the model does " +
      "not have is left out.",
    `- Sound panel: tool ${quoted(t("canvas.generatePanel.reference"))}, then the source slots. The settings pill ` +
      "shows a speaker icon and the current voice and settings, for example Alex · 1.00x, or " +
      `${quoted(t("canvas.generatePanel.voicePlaceholder"))} until a voice is picked. Clicking it opens rows such ` +
      `as ${quoted(t("canvas.generatePanel.audioVoice"))}, which opens the voice list beside it with a search box, ` +
      "sliders such as speed, volume, stability and similarity when the model has them, on some models a choice " +
      "between a single voice and a dialogue, and any settings of the model's own.",
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
      "up to eight rows; the arrow keys move through it, Enter picks and Esc closes it. Only choosing a row makes " +
      "a mention, and typing the name alone does not. Clicking a chip in the strip above the prompt inserts it " +
      "too; a faded chip shows a message saying why instead. Backspace removes a mention whole. Enter in the " +
      "prompt starts a new line and never generates.",
    "",
    "## Groups and undo",
    "Drag on empty canvas to draw a box; nodes fully inside it are selected. With two or more loose nodes " +
      `selected, a small bar above them shows ${quoted(t("canvas.group.group"))} (right-clicking the selection ` +
      "offers it too), or press Cmd/Ctrl+G. With an unlocked group selected, the bar shows a colour swatch, which " +
      `lists a no-colour dot and seven colours for its background, and ${quoted(t("canvas.group.ungroup"))}, or ` +
      "press Cmd/Ctrl+Shift+G. Undo is Cmd/Ctrl+Z; redo is Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y; the bar at the bottom " +
      "right has both.",
    "",
    "## Proposal cards",
    "A proposal you make appears in this chat as a card: a summary of a sentence or two; the nodes as chips " +
      "joined by arrows in the order they run (empty nodes drawn dashed), with a | between runs that do not feed " +
      "each other; any finished text in full; when every generating node uses the same model, a line with that " +
      `model's name and a note on it; the credit estimate and time; and a ${quoted(t("chat.proposal.use"))} ` +
      "button. Under each node it lists what is left for the reader, and for each generating node it ends with " +
      `${quoted(t("chat.proposal.promptReady"))}, or ${quoted(t("chat.proposal.settingsReady"))} where the model ` +
      "has no prompt box.",
    `Pressing ${quoted(t("chat.proposal.use"))} places the nodes near the middle of the reader's view, wired ` +
      "together and grouped when there are two or more, as one step undo reverses. A canvas has to be open: " +
      `anywhere else pressing it shows the message ${quoted(t("chat.proposal.needCanvas"))} and places nothing. ` +
      "With one generating node its panel opens by itself; with several, the group is selected and the reader " +
      `right-clicks each node and chooses ${quoted(t("canvas.nodeMenu.generate"))}.`,
    "Each generating node arrives empty, with its mode and model set and, when the model has a prompt box, its " +
      "prompt written. Where the model has none, a picture or video panel shows " +
      `${quoted(t("canvas.generatePanel.promptNotUsed"))}, and a sound panel shows its prompt box empty. The ` +
      "reader generates the nodes in the order the card's arrows run, each before the node it feeds.",
    "Spots left for the reader are in square brackets, in a prompt or in a finished text node's words. A ✏️ spot " +
      "is a phrase to replace with their own words, or a setting to pick in the panel. A 📎 spot is material only " +
      "the reader has; it usually goes in an empty node the proposal placed, which they double-click to pick a " +
      "file. Each spot's note is also a line on the card.",
    "How work reaches a node depends on where it goes:",
    "- Into the reference list: the prompt mentions it where the proposal points at it, and a 📎 spot already " +
      "mentions its empty node.",
    "- Into one of the mode's source slots: it is not mentioned. The reader's own material still has its 📎 " +
      "note on the card; a generated result has no line. Once that node holds its file or its generated result, " +
      "the reader opens the panel of the node it feeds, presses that slot's button and clicks the node.",
    "",
    "## Document spaces",
    "- Markdown at the start of a line: `# `, `## `, `### ` for headings; a number, a full stop and a space " +
      "(`1. `) for an ordered list; `- `, `* ` or `+ ` for a bullet list; `[ ] ` for a to-do (`[x] ` ticked); " +
      "three backticks then a space for a code block (a language name may go between them); `> ` for a quote. " +
      "Inside a line, `**bold**`, `*italic*`, `~~struck~~` and `` `code` `` turn into that formatting, and a " +
      "web address followed by a space becomes a link; Backspace right after undoes the change.",
    "- Shortcuts, Cmd and Option on a Mac, Ctrl and Alt elsewhere: Cmd+Alt+0 plain text, Cmd+Alt+1/2/3 headings, " +
      "Cmd+Shift+8 bullet list, Cmd+Shift+7 ordered list, Cmd+Shift+9 to-do, Cmd+Alt+C code block, Cmd+Shift+B " +
      "quote; pressing the shortcut of the type a block already has turns it back to plain text. Cmd+B bold, Cmd+I " +
      "italic, Cmd+U underline, Cmd+Shift+S strikethrough, Cmd+E inline code. There is no shortcut for a link.",
    "- Keys: Enter starts a new block; in a list it starts a new item of the same kind, and on an empty item it " +
      "ends the list. Shift+Enter breaks the line inside the block. Backspace at the start of a heading, list item or code block " +
      "turns it back into plain text. Tab indents the block under the one above " +
      "(a list item becomes a nested item); Shift+Tab moves it back out. Cmd+Shift+Up and Cmd+Shift+Down move " +
      "the block up or down. Cmd+Z undoes your own edits " +
      "only; Cmd+Shift+Z or Cmd+Y redoes. Cmd+A selects the block's text, and a second Cmd+A the whole document; " +
      `deleting everything asks ${quoted(t("spaces.document.clearConfirm.title"))} first.`,
    "- Clicking the empty space below the last block starts a new block there. Clicking a to-do's box ticks it. " +
      "Clicking a link opens it in a new tab. Pasting Markdown turns it into headings, lists and so on.",
    "- Selecting text shows a bar, left to right: an icon of the current block type with a small arrow, an " +
      "alignment icon with an arrow, bold B, italic I, strikethrough S and underline U icons, a link icon, a code " +
      "icon, the letter A with an arrow (colour), a speech-bubble icon (comment), and a sparkle with the word " +
      `${quoted(t("spaces.document.commands.ai"))} and an arrow. The other buttons show no name on hover. Hovering ` +
      "the block type, alignment, colour or AI button opens its menu. Hovering the speech bubble shows " +
      `${quoted(t("spaces.document.commands.comment"))} marked not open yet. The AI menu's commands look ` +
      "available but do nothing yet.",
    `- The link icon opens a box, ${quoted(t("spaces.document.link.placeholder"))}, with ` +
      `${quoted(t("spaces.document.link.confirm"))}; for an address that is not one, ` +
      `${quoted(t("spaces.document.link.confirm"))} stays greyed and the box shows ` +
      `${quoted(t("spaces.document.link.invalid"))}. On text that is already a link, and when hovering a link, ` +
      `it shows the address, ${quoted(t("spaces.document.link.edit"))} and ` +
      `${quoted(t("spaces.document.link.remove"))}. The colour menu has a ` +
      `${quoted(t("spaces.document.commands.textColor"))} row, a ` +
      `${quoted(t("spaces.document.commands.fillColor"))} row and ` +
      `${quoted(t("spaces.document.commands.colorReset"))}.`,
    "- Hovering a line shows a handle at its left. Drag it to move the block; click it for a menu with " +
      `${quoted(t("spaces.document.commands.blockType"))}, ${quoted(t("spaces.document.blockHandle.duplicate"))}, ` +
      `${quoted(t("spaces.document.blockHandle.insertBelow"))}, ${quoted(t("spaces.document.commands.align"))}, ` +
      `${quoted(t("spaces.document.commands.color"))}, ${quoted(t("spaces.document.commands.comment"))} (marked ` +
      `not open yet) and ${quoted(t("spaces.document.blockHandle.delete"))}.`,
    `- An empty document shows ${quoted(t("spaces.document.placeholder"))}. Three dots at the top right open ` +
      `${quoted(t("spaces.document.docMenu.saveSnapshot"))} and ` +
      `${quoted(t("spaces.document.docMenu.restoreSnapshot"))}, both marked ` +
      `${quoted(t("spaces.document.docMenu.notOpenYet"))}. People who can only view the project can select and ` +
      "copy text, and get no bar and no handle.",
    "- There is no slash menu. Not available yet: comments, the AI commands, snapshots, images or other media, " +
      "tables, dividers, toggle lists, and headings below level 3.",
  ].join("\n");
}

export const productGuide: Tool<z.infer<typeof inputSchema>, string> = tool({
  description:
    "How the reader operates our product: the space tabs and the spaces list, this chat panel, and on a canvas " +
    "making, filling and connecting nodes, node menus, notes, moving around, the generation panel and what is in " +
    "it, source slots, focus crops, mentions, groups, placing a proposal card; and writing in a document. Read it before telling the reader how to do something here: you cannot see " +
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
