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
    "You are talking to someone who can edit this project: people who can only view it do not get this chat.",
    "",
    "## The top bar",
    "Left to right: the brand mark, which opens our website in a new tab; an arrow with the word Studio, which " +
      "goes back to the studio; the project's name, which double-clicking renames (Enter or clicking away saves, " +
      "Esc or an empty name keeps the old one); and the reader's role, " +
      `${quoted(t("role.owner"))} or ${quoted(t("role.editor"))}.`,
    "On the right: the members' pictures with a small arrow, which open " +
      `${quoted(t("members.popover.title"))}; for the owner that list ends with ` +
      `${quoted(t("members.popover.manage"))}, which opens ${quoted(t("members.modal.title"))} to change a ` +
      "member's role, remove a member or hand the project to someone else. Then a globe with the current " +
      "language, which lists the five languages; an icon for the theme, which offers " +
      `${quoted(t("preferences.themeMode.light"))}, ${quoted(t("preferences.themeMode.dark"))} and ` +
      `${quoted(t("preferences.themeMode.system"))}; and a star with the number of credits available, which ` +
      "only shows the balance. The owner also has a person icon with a plus, which opens " +
      `${quoted(t("share.inviteSection"))}: type an address, pick ${quoted(t("share.role.view"))} or ` +
      `${quoted(t("share.role.edit"))} and press ${quoted(t("share.inviteButton"))}; after sending, ` +
      `${quoted(t("share.inviteLinkLabel"))} shows a link to copy. Last is a bell, with a red dot when something ` +
      `waits, which opens ${quoted(t("notifications.title"))}: each item has ` +
      `${quoted(t("notifications.openDecision"))}, which opens it, and ${quoted(t("notifications.markRead"))}.`,
    `When a new version of the site is out, a ${quoted(t("project.update.available"))} button appears on the ` +
      `right; it asks whether to refresh now (${quoted(t("project.update.refresh"))}) or ` +
      `${quoted(t("project.update.later"))}.`,
    "",
    "## Spaces",
    "A project holds spaces; the ones open right now are tabs along the top. On a first visit only the newest " +
      `space is open, and the rest are listed under ${quoted(t("spaces.drawer.title"))} (below). Each tab shows a ` +
      "type icon and the " +
      "space's name, and hovering a tab shows its full name. Click a tab to switch to it. Double-click the name " +
      "to rename it: Enter or clicking away saves, Esc or an empty name keeps the old one. A locked space shows a " +
      `small padlock after its name, and trying to rename it shows ${quoted(t("spaces.rename.locked"))} ` +
      "Locking a space only stops it being renamed or deleted; what is in it stays editable. Hovering a tab " +
      "also shows a small X at its right end, which closes the tab; the space stays in the project. While an " +
      `upload in that space is still running, closing it shows ${quoted(t("canvas.close.operationInProgress"))} ` +
      "Drag a tab sideways to reorder the tabs. When the tabs do not fit, arrows at either end scroll them. Just " +
      "right of the tabs a crosshair button scrolls the current tab into view; it is greyed while that tab is " +
      "already in view.",
    "To the right of the tabs, past a thin divider, are three icon buttons. The first, a plus sign, opens a " +
      `dialog for a new space: pick the ${quoted(t("spaces.kind.canvas"))} or ` +
      `${quoted(t("spaces.kind.document"))} card (${quoted(t("spaces.kind.canvas"))} is selected when it opens; ` +
      `a third, greyed card is not available yet), type a name and press ${quoted(t("spaces.create.submit"))}, ` +
      "which stays greyed until there is a name. The new space opens as a tab once it is ready.",
    "The second, three lines with the number of spaces beside them, opens " +
      `${quoted(t("spaces.drawer.title"))}: every space in the project, newest first, each with its type icon, ` +
      `name and when it was made; the one open now is marked ${quoted(t("spaces.drawer.status.editing"))} and ` +
      `others open as tabs ${quoted(t("spaces.drawer.status.open"))}. Clicking a row opens that space as a tab. ` +
      `Hovering a row shows three icons: an eye (${quoted(t("spaces.drawer.action.view"))}), a padlock ` +
      `(${quoted(t("spaces.drawer.action.lock"))} or ${quoted(t("spaces.drawer.action.unlock"))}) and a bin ` +
      `(${quoted(t("spaces.drawer.action.delete"))}), which asks before deleting. The bin is greyed on a locked ` +
      "space and on the project's only space. The eye switches to a space already open as a tab; on any other " +
      "space it opens a read-only panel that does not show the space's content yet, so open the space itself to " +
      "see it.",
    `The third, a pulse line, opens ${quoted(t("activity.header"))}: the project's uploads, generations and ` +
      "changes to spaces and members. The project's owner sees " +
      `${quoted(t("activity.action.restore"))} on a deleted space's entry, which brings the space back; ` +
      `afterwards that entry shows ${quoted(t("activity.action.restored"))}`,
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
    "A new conversation greets the reader and offers three suggestions; clicking one puts its words in the " +
      "message box without sending them. Enter sends the message and Shift+Enter starts a new line. The round " +
      "button with an upward arrow at the right of the box sends too; while a reply is being written it becomes a " +
      "red square, which stops the reply. A message holds up to 10,000 characters.",
    "The plus sign at the bottom left of the box attaches up to ten pictures, videos, sounds, PDF, Word (.docx), " +
      "Excel or plain text files to the next message. Canvas nodes are handed over with " +
      `${quoted(t("canvas.contextMenu.addToAgent"))} on their right-click menu. Each attachment shows as a small ` +
      "chip in the box above the text, with a type and a name; hovering it previews it and its X removes it.",
    "Hovering a message the reader sent shows when it was sent and a copy icon. A reply may start with a fold " +
      `(${quoted(t("chat.thinkingNow"))} while it runs) that opens to show the thinking. Links in a reply open in ` +
      "a new tab. A code block shows a copy icon when hovered. Small numbered circles in the text are sources: " +
      "hovering one shows it and clicking opens it. Pictures found for the reader appear as a row of squares; " +
      "clicking one opens it large. Under a finished reply are a copy icon and, when it used sources, a Sources " +
      "button with their number that lists them. A reply that did not end normally says so on its last line, " +
      "with one of these:",
    `  - ${quoted(t("chat.error.turnFailed"))}`,
    `  - ${quoted(t("chat.message.truncated"))}`,
    `  - ${quoted(t("chat.message.interrupted"))}`,
    `  - ${quoted(t("chat.message.blocked"))}`,
    `  - ${quoted(t("chat.message.empty"))}`,
    `When the conversation has older messages, ${quoted(t("chat.loadEarlier"))} at the top shows them. After ` +
      "scrolling up, a round button with a downward arrow at the bottom goes back to the latest. If sending fails, " +
      `a line above the box says so, such as ${quoted(t("chat.error.network"))}`,
    "",
    "## Making nodes",
    "- Right-click an empty spot on the canvas (inside a group's box you get the group's menu instead) and pick " +
      `${typeLabel("text")}, ${typeLabel("image")}, ${typeLabel("audio")} or ${typeLabel("video")}; the node ` +
      `appears centred where you clicked. The same menu has ${quoted(t("canvas.contextMenu.paste"))}, which puts ` +
      "copied nodes or copied text at the spot you clicked; a copied picture, screenshot or file does nothing " +
      "there, so paste those with Cmd/Ctrl+V.",
    "- On a canvas space a floating menu of icons runs along the left edge; each names itself when hovered. " +
      `${quoted(t("menu.item.nodes"))} (a sparkle) opens a list of the same types; the node appears in the ` +
      "middle of the view.",
    "- Drop files onto the canvas, or paste one. Pictures, videos and sounds become nodes of their kind; one in " +
      "a format that is not supported, or over the size limit, makes no node, and a message names it. A file " +
      "whose contents turn out to be another format than its name says is refused after its node appears, and " +
      "the node shows the failure. Any other file becomes a text node holding its text: plain text, PDF, Word " +
      "(.docx) and Excel (.xlsx, .xls) files work; other kinds, older .doc files included, show an error in the " +
      "node. An empty file makes no node, and a message names it. Several files at once arrive four to a row " +
      "inside a new group named after how many they are; if only one of them is accepted, it arrives alone.",
    `- ${quoted(t("menu.item.upload"))} (an arrow pointing up out of a tray) in that menu opens a file picker ` +
      "that lists pictures, videos, sounds and plain text files; PDF, Word and Excel files go in by dropping or " +
      "pasting them. What you pick arrives the same way as dropped files, in the middle of the view.",
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
      "double-clicking it, or the text of a text node that has some, lets you type; Esc or clicking elsewhere " +
      "ends typing. To replace what a node holds, right-click it and choose " +
      `${quoted(t("canvas.nodeMenu.upload"))}: a picture, video or sound node takes a new file of its kind, a ` +
      "text node takes the text of a plain text, PDF, Word (.docx) or Excel file; a file of another kind is " +
      `refused with ${quoted(t("canvas.upload.typeMismatch"))}`,
    "When a node's last task failed, the node shows " +
      `${quoted(t("canvas.task.someFailed"))} and a ${quoted(t("canvas.task.view"))} button in place of its ` +
      "content, and a red border; the button opens the failed task. Double-clicking it then does not pick a " +
      `file; use ${quoted(t("canvas.nodeMenu.upload"))} instead. A picture or video node shows its width × ` +
      "height just outside its top-right corner. Video and sound nodes have their own play, time, volume and, " +
      "for video, full-screen controls.",
    "Every picture, video, sound and text node shows its name just above its top-left corner, after a type " +
    "icon. A new node is named Text, Image, Audio or Video in every language; a copy is named COPY- followed " +
      "by the original's name, and a node made by " +
      `${quoted(t("canvas.nodeMenu.understand"))} UNDERSTAND- followed by the name of the node it read. ` +
      "Double-click the name to rename it: Enter or clicking away saves, Esc or an empty name keeps the old one. " +
      "A group's name sits at its top-left and renames the same way. A locked node's or group's name cannot be " +
      "changed, and double-clicking it does nothing.",
    "",
    "## Node menus",
    "Right-clicking a node opens its menu (right-clicking inside text being typed opens the browser's own menu). " +
      "On a picture, video, sound or text node the rows are, top to bottom:",
    `- ${quoted(t("canvas.nodeMenu.generate"))} (greyed on a text node) and ` +
      `${quoted(t("canvas.nodeMenu.upload"))}.`,
    `- On a picture node, ${quoted(t("canvas.nodeMenu.resetEmpty"))}: a panel under the node, headed ` +
      `${quoted(t("canvas.emptyImage.title"))}, takes a ratio or a width and height and a colour; the round button ` +
      "with an upward arrow replaces the picture with a blank one of that size and colour, and the X closes the " +
      "panel without a change.",
    `- ${quoted(t("canvas.nodeMenu.history"))}: a panel listing every generation, upload and snapshot on the ` +
      `node, each marked ${quoted(t("canvas.history.typeGeneration"))}, ` +
      `${quoted(t("canvas.history.typeUpload"))} or ${quoted(t("canvas.history.typeSnapshot"))}; the one it ` +
      `holds now is marked ${quoted(t("canvas.history.current"))}, ${quoted(t("canvas.history.restore"))} puts ` +
      `an earlier one back, and a failed attempt shows ${quoted(t("canvas.history.failed"))}. A node with none ` +
      `shows ${quoted(t("canvas.history.empty.title"))}`,
    `- On a text node, ${quoted(t("canvas.nodeMenu.snapshot"))}, greyed while the node is empty: it keeps a copy ` +
      `of the node's words in its history and shows ${quoted(t("canvas.history.snapshotKept"))}`,
    `- On a picture, video or sound node, ${quoted(t("canvas.nodeMenu.download"))}, which saves the file, then ` +
      `${quoted(t("canvas.nodeMenu.understand"))}, which writes a description of what the node holds into a new ` +
      `text node connected to it, and ${quoted(t("canvas.nodeMenu.tools"))}, which is always greyed: it is not ` +
      `open yet. ${quoted(t("canvas.nodeMenu.download"))} and ${quoted(t("canvas.nodeMenu.understand"))} are ` +
      "greyed while the node holds nothing or shows a failure in place of its content.",
    `- ${quoted(t("canvas.contextMenu.copy"))} (Cmd/Ctrl+C) and ${quoted(t("canvas.contextMenu.duplicate"))} ` +
      "(Cmd/Ctrl+D), which places a copy slightly below and to the right.",
    `- ${quoted(t("canvas.contextMenu.rename"))} and ${quoted(t("canvas.nodeMenu.lock"))} or ` +
      `${quoted(t("canvas.nodeMenu.unlock"))}. A locked node shows a small padlock at its top-right corner and ` +
      `has no ${quoted(t("canvas.contextMenu.rename"))} row; moving, deleting, filling or generating into it ` +
      `shows ${quoted(t("canvas.gate.locked"))} Its generation panel still opens.`,
    `- ${quoted(t("canvas.contextMenu.addToAgent"))}, then ${quoted(t("canvas.contextMenu.deleteNode"))} ` +
      "(Backspace or Delete). A node with tasks still running is not deleted: " +
      `${quoted(t("canvas.gate.handling"))}`,
    `A group's menu has ${quoted(t("canvas.contextMenu.copy"))}, ${quoted(t("canvas.contextMenu.duplicate"))}, ` +
      `${quoted(t("canvas.group.ungroup"))}, ${quoted(t("canvas.contextMenu.rename"))}, ` +
      `${quoted(t("canvas.group.lock"))} or ${quoted(t("canvas.group.unlock"))}, ` +
      `${quoted(t("canvas.contextMenu.addToAgent"))} and ${quoted(t("canvas.contextMenu.deleteGroup"))}, which ` +
      `deletes the group with everything in it (${quoted(t("canvas.group.ungroup"))} keeps the members). A ` +
      `locked group has no ${quoted(t("canvas.group.ungroup"))} or ${quoted(t("canvas.contextMenu.rename"))}; ` +
      "its members cannot be moved, deleted or dragged out, but their contents and names can still change. After " +
      "dragging a box around several nodes, right-clicking the selection opens " +
      `${quoted(t("canvas.group.group"))} (when at least two of them are neither a note, a group nor inside one), ` +
      `${quoted(t("canvas.contextMenu.copy"))}, ${quoted(t("canvas.contextMenu.duplicate"))}, ` +
      `${quoted(t("canvas.contextMenu.addToAgent"))} and ${quoted(t("canvas.contextMenu.deleteSelection"))}. ` +
      "With nodes picked one by one with Cmd/Ctrl-click, right-clicking one opens that node's own menu. A note's " +
      `menu has ${quoted(t("canvas.nodeMenu.lock"))} or ${quoted(t("canvas.nodeMenu.unlock"))}, ` +
      `${quoted(t("canvas.contextMenu.addToAgent"))} and ${quoted(t("canvas.contextMenu.deleteNode"))}.`,
    "",
    "## Notes",
    `${quoted(t("menu.item.comment"))} (a speech bubble) in the left menu leaves a note on the canvas: press it, ` +
      "and the button turns solid and the pointer turns into a speech bubble; click a spot and a small box in " +
      `the note colour opens there with ${quoted(t("canvas.annotation.placeholder"))}. Shift+Enter starts a new ` +
      "line; Enter posts the note (with nothing typed it does nothing); Esc or clicking away drops it. Before " +
      "clicking a spot, Esc, a right-click or pressing the button again cancels. A posted note is a small round " +
      "bubble showing its author's picture, or their initials, with a count of replies at its top right once " +
      "anyone replies. Clicking it opens the note and its replies, with a " +
      `${quoted(t("canvas.annotation.replyPlaceholder"))} box under them unless the note is locked; clicking the ` +
      "bubble again, Esc or clicking elsewhere closes it. In a note, the author's three dots offer " +
      `${quoted(t("canvas.annotation.edit"))} and ${quoted(t("canvas.annotation.delete"))}, and the project's ` +
      `owner gets ${quoted(t("canvas.annotation.delete"))} on anyone's; a locked note shows no three dots. ` +
      "Deleting someone else's note from the canvas, unless you own the project, shows " +
      `${quoted(t("canvas.gate.notYours"))}`,
    "Below a thin line the left menu has three more icons, " +
      `${quoted(t("menu.item.collection"))}, ${quoted(t("menu.item.help"))} and ` +
      `${quoted(t("menu.item.feedback"))}, which do nothing yet.`,
    "",
    "## Moving around the canvas",
    "At the bottom right of a canvas is a bar, left to right: " +
      `${quoted(t("viewportToolbar.undo"))} and ${quoted(t("viewportToolbar.redo"))} (curved arrows); ` +
      `${quoted(t("viewportToolbar.zoomOut"))} (a minus), the zoom percentage and ` +
      `${quoted(t("viewportToolbar.zoomIn"))} (a plus); ${quoted(t("viewportToolbar.fit"))} (four corner ` +
      "brackets), which frames every node; " +
      `${quoted(t("viewportToolbar.snap.label"))} (a grid, off at first) and ` +
      `${quoted(t("viewportToolbar.minimap.label"))} (on at first), each a solid square while on. Clicking the ` +
      "percentage lists 10%, 25%, 50%, 100%, 150%, 200%, 400% and 800%, and has a box to type any value from 10 " +
      "to 800 and press Enter. The minimap can be dragged to move the view and scrolled to zoom. The left menu " +
      "and this bar slide out of sight while nodes are being picked for a panel. Each space reopens where you " +
      "left it; one never opened before frames all its nodes.",
    "Scroll to pan (over a text node's text, an open panel or a note, scrolling scrolls that instead), or hold " +
      "Space and drag; pinch or hold Ctrl and scroll to zoom. Cmd/Ctrl with plus or minus zooms the whole browser " +
      "page, not the canvas. Except while nodes are being picked for a panel or a note is being placed, click a " +
      "node to select it and Cmd/Ctrl-click to add or remove one. Cmd/Ctrl+A does not select every node. " +
      "Backspace or Delete, when not typing in a field, removes the selected nodes and connections; locked ones, " +
      "ones with tasks still running and notes you may not delete stay, and a message says why. Other people in " +
      "the same space show as named pointers and as name tags on what they have selected.",
    "",
    "## Generating",
    generatingLine(),
    `Right-click such a node and choose ${quoted(t("canvas.nodeMenu.generate"))} (on a text node that row is ` +
      "greyed): the generation panel opens just below the node. Clicking a node selects it without opening the " +
      "panel. The panel closes with the X at its top-right, once a run you started is accepted, when another " +
      "panel opens on the canvas, or when the node stops being selected; while you are picking nodes for it, " +
      "clicking other nodes keeps it open. Esc does not close it. When the model list cannot be loaded, the panel " +
      "does not open and a message says why.",
    "Fill in what the panel asks for (usually the prompt; some modes also need a source slot filled or a voice " +
      "picked), then press the round button with an upward arrow at the right end of the panel's bottom row. If " +
      "something is missing, pressing it shows a message saying what, such as " +
      `${quoted(t("canvas.generatePanel.refuseExecuteNoPrompt"))} or ` +
      `${quoted(t("canvas.generatePanel.refuseExecuteNoVoice"))} When the run finishes, its result replaces what ` +
      "the node held.",
    "A small column of icons appears just past the node's right edge, level with its top, one icon for each " +
      "state that has tasks, uploads included: a spinning circle (running), a circle with a tick (done), a circle " +
      "with an X (failed), a clock (expired). Hovering one shows how many; clicking it lists them. Zoomed far out, " +
      "only the spinning one remains. In that list a running task shows how long it has run and has left; a done " +
      `one offers ${quoted(t("canvas.task.action.replace"))}, which puts its result on the node, and ` +
      `${quoted(t("canvas.task.action.finish"))}; a failed one says why and offers ` +
      `${quoted(t("canvas.task.action.retry"))} for an upload still at hand, and ` +
      `${quoted(t("canvas.task.action.clear"))}; an expired one offers ` +
      `${quoted(t("canvas.task.action.replace"))} when a late result came, and ` +
      `${quoted(t("canvas.task.action.clear"))}.`,
    "",
    "## Inside the generation panel",
    "The top row holds the tool buttons, each an icon over its name, with an X at the far right that closes the " +
      "panel. Below it, only when there are some, is a strip of chips: one for each node connected into this one " +
      "and one for each focus crop. A chip shows a thumbnail or type icon, the source node's name (a focus crop " +
      "adds a crop icon before the name) and a small X; a chip the current mode or model cannot use is faded, and " +
      "hovering a chip previews it. On a connected node's chip the X deletes that connection from the canvas; on " +
      "a focus crop's chip it deletes the crop. Then the prompt box, or, on video models that take no prompt, the " +
      `line ${quoted(t("canvas.generatePanel.promptNotUsed"))} in its place. On the music modes the box is ` +
      `labelled ${quoted(t("canvas.generatePanel.musicStyleLabel"))}, and some music models add a second box ` +
      `labelled ${quoted(t("canvas.generatePanel.musicLyricsLabel"))} under it.`,
    "The bottom row, left to right: the mode, named in English on every screen (for example Text to Image); the " +
      "model's maker icon and name; a pill showing the current settings (for example 1k · 1:1 · Medium); on the " +
      "picture panel, a camera icon when the model has camera settings; then at the right end the credit " +
      "estimate, a star with a number that may read ≥ or ≤ a number, or so much per 1K characters, and is missing " +
      "when no estimate is available; and the round button with an upward arrow. On the picture panel a model " +
      `with no settings shows the pill as ${quoted(t("canvas.generatePanel.imageParams"))}; on the video and ` +
      "sound panels such a model shows no pill.",
    "Clicking the mode lists the modes this node's type offers; picking one changes which models are offered. " +
      "Clicking the model's name lists the current mode's models, each with its maker's icon, its name and a line " +
      "saying what it is good at; picking one switches to it. Mode and model together decide which slot buttons " +
      "and settings show.",
    `- Picture panel: tools ${quoted(t("canvas.generatePanel.reference"))}, ` +
      `${quoted(t("canvas.generatePanel.focus"))}, and ${quoted(t("canvas.generatePanel.style"))} when the model ` +
      "takes a style picture. Clicking the settings pill opens whichever of resolution and ratio the model has, " +
      "and any settings of the model's own, such as quality. The camera icon opens a panel headed " +
      `${quoted(t("canvas.generatePanel.camera"))} with an on/off switch and wheels for ` +
      `${quoted(t("canvas.generatePanel.lens"))}, ${quoted(t("canvas.generatePanel.focalLength"))} and ` +
      `${quoted(t("canvas.generatePanel.aperture"))} as well as the camera itself.`,
    `- Video panel: tools ${quoted(t("canvas.generatePanel.reference"))} and ` +
      `${quoted(t("canvas.generatePanel.focus"))}, then after a thin divider one button for each source slot. The ` +
      "settings pill shows values such as 16:9 · 720p · 8s; clicking it opens ratio, resolution, duration, a " +
      "switch to generate sound on models that can, and any settings of the model's own. A setting the model does " +
      "not have is left out.",
    `- Sound panel: tool ${quoted(t("canvas.generatePanel.reference"))}, then the source slots. Here only a ` +
      "connected text node can be mentioned; a connected sound shows as a faded chip, and a sound goes in through " +
      "its slot. On a model with voices the settings pill shows a speaker icon and the current voice and " +
      "settings, for example Alex · 1.00x, or " +
      `${quoted(t("canvas.generatePanel.voicePlaceholder"))} until a voice is picked; clicking it opens rows such ` +
      `as ${quoted(t("canvas.generatePanel.audioVoice"))}, which opens the voice list beside it with a search box, ` +
      "sliders such as speed, volume, stability and similarity when the model has them, on some models a choice " +
      "between a single voice and a dialogue, and any settings of the model's own. On other models the pill shows " +
      "only their settings. A sound node made before sound generation existed shows only " +
      `${quoted(t("canvas.generatePanel.audioLegacyNoPrompt"))}`,
    "",
    "## Source slots",
    "Some modes and models take a particular source in a place of its own and show a button for each, after the " +
      `divider, an icon over its name: for example ${quoted(t("canvas.generatePanel.firstFrame"))}, ` +
      `${quoted(t("canvas.generatePanel.endFrame"))}, ${quoted(t("canvas.generatePanel.characterImage"))}, ` +
      `${quoted(t("canvas.generatePanel.drivingVideo"))}, ${quoted(t("canvas.generatePanel.drivingAudio"))}, ` +
      `${quoted(t("canvas.generatePanel.refAudio"))}, ${quoted(t("canvas.generatePanel.musicSong"))}, or on the ` +
      `picture panel ${quoted(t("canvas.generatePanel.style"))}. Some must be filled before a run; others are ` +
      "optional. Press a slot's button, then click a node on the canvas: only nodes that fit stay lit. The node's " +
      "content is copied into the slot and picking ends. A slot holding a picture, or a video with a cover, shows " +
      "that picture in place of its icon and name; a slot holding a sound keeps its icon and name and gets a " +
      "coloured border. To replace it, press the filled slot and click another node. Pressing the slot again " +
      `while picking, Esc, or ${quoted(t("canvas.generatePanel.exitSelect"))} in the bar at the top stops picking ` +
      "without a change. The X on a filled slot empties it. A required slot left empty stops the run with a " +
      "message naming it, while the arrow button stays active. A slot holds a copy and needs no connection or " +
      "mention.",
    "",
    "## Connections",
    "Picture, video, sound and text nodes show a small dot on their left and right edges; groups and notes have " +
      "none. Drag from a node's right dot to another node's left dot, or click one dot and then the other; the " +
      "first node then shows as a chip in the second node's generation panel. A pair that is not allowed snaps " +
      "back with a message. What may connect into each node:",
    ...connectionLines(),
    "A text node does not generate, so nothing uses what is connected into it; into a sound node only a " +
      "connected text node can be used. A node takes at most 50 connections and focus crops together; past that " +
      "a new one is refused with a message.",
    `In a generation panel, ${quoted(t("canvas.generatePanel.reference"))} lets you click nodes on the canvas ` +
      `to connect them; ${quoted(t("canvas.generatePanel.exitSelect"))} in the bar at the top, Esc, or pressing ` +
      `${quoted(t("canvas.generatePanel.reference"))} again stops. To remove a connection, select it and press the ` +
      `scissors at its middle, right-click it and choose ${quoted(t("canvas.edge.delete"))}, or press the X on ` +
      "its chip in the panel.",
    "",
    "## Focus crops",
    `In a picture or video panel, ${quoted(t("canvas.generatePanel.focus"))} takes a region of a picture or ` +
      "video node as a reference: press it, click a picture or video node that holds something and is not still " +
      "processing (only those stay lit), and drag a box over the part you want. A bar under the node offers " +
      `fixed ratios for the box, ${quoted(t("canvas.generatePanel.focusCancel"))} and ` +
      `${quoted(t("canvas.generatePanel.focusConfirm"))}; for a video, first drag its timeline in that bar to ` +
      "choose the frame, and the crop is a still picture of that frame. After " +
      `${quoted(t("canvas.generatePanel.focusConfirm"))}, the crop joins the strip above the prompt as a chip ` +
      "with a crop icon before the source node's name (a spinner shows while it uploads); if it cannot be made, " +
      "a message says so. Picking goes on after " +
      `${quoted(t("canvas.generatePanel.focusConfirm"))} or ${quoted(t("canvas.generatePanel.focusCancel"))}, ` +
      `so another crop can be taken; ${quoted(t("canvas.generatePanel.exitSelect"))} in the bar at the top, Esc ` +
      `or pressing ${quoted(t("canvas.generatePanel.focus"))} again stops. A crop is a copy: it needs no ` +
      "connection, and it stays if the source node changes.",
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
    "Except while nodes are being picked for a panel or a note is being placed, drag on empty canvas to draw a " +
      "box; nodes fully inside it are selected. With two or more nodes selected that are neither notes, groups " +
      `nor inside a group, a small bar above them shows ${quoted(t("canvas.group.group"))} (right-clicking the ` +
      "selection offers it too), or press Cmd/Ctrl+G; notes in the selection are left out. With a single unlocked " +
      "group selected on its own, the bar shows a colour swatch, which lists a no-colour dot and seven colours " +
      `for its background, and ${quoted(t("canvas.group.ungroup"))}, or press Cmd/Ctrl+Shift+G. A selected ` +
      "unlocked group has handles on its edges and corners to resize it. Drag a node into an unlocked group to " +
      "add it: it joins when its centre ends inside the group, and dragging it until its centre leaves takes it " +
      "out. A group grows to fit a member that pokes out. Undo is Cmd/Ctrl+Z; redo is Cmd/Ctrl+Shift+Z or " +
      "Cmd/Ctrl+Y; the bar at the bottom right has both.",
    "",
    "## Proposal cards",
    "A proposal you make appears in this chat as a card: a summary of a sentence or two; the nodes as chips, one " +
      "column per step with arrows between steps in the order they run (nodes of the same step stacked, empty " +
      "nodes drawn dashed), with a | between runs that do not feed each other; any finished text in full under " +
      "its node's name; when every generating node uses the same model and you gave a model note, a line with " +
      "that model's name and the note; the list of what is left for the reader; and a " +
      `${quoted(t("chat.proposal.use"))} button. The card shows no credits and no run time; the credit ` +
      "estimate is in each node's generation panel.",
    "The list of what is left is headed by node names when the proposal places more than one node; nodes with " +
      "the same list share one heading, joined by ·. Each generating node's list ends with one of these two " +
      "lines, the second where the model has no prompt box: " +
      `${quoted(t("chat.proposal.promptReady"))} ${quoted(t("chat.proposal.settingsReady"))}`,
    `Pressing ${quoted(t("chat.proposal.use"))} places the nodes near the middle of the reader's view, wired ` +
      "together and grouped when there are two or more, as one step undo reverses; the button reads " +
      `${quoted(t("chat.proposal.building"))} meanwhile, and ${quoted(t("chat.proposal.failed"))} appears if it ` +
      "fails. A canvas has to be open: " +
      `anywhere else pressing it shows the message ${quoted(t("chat.proposal.needCanvas"))} and places nothing. ` +
      "With one generating node its panel opens by itself; with several, the group is selected and the reader " +
      `right-clicks each node and chooses ${quoted(t("canvas.nodeMenu.generate"))}.`,
    "Each generating node arrives empty, with its mode, model and the settings the proposal chose already set " +
      "and, when the model has a prompt box, its prompt written. Where the model has none, a picture or video " +
      `panel shows ${quoted(t("canvas.generatePanel.promptNotUsed"))} in place of the box, and a sound panel ` +
      "still shows a box that holds only the proposal's bracketed spots, if any; nothing typed there is sent. " +
      "The reader generates the nodes in the order the card's arrows run, each before the node it feeds.",
    "Spots left for the reader are in square brackets, in a prompt or in a finished text node's words. A ✏️ spot " +
      "is a phrase to replace with their own words, or a setting to pick in the panel. A 📎 spot is material only " +
      "the reader has; it usually goes in an empty node the proposal placed, which they double-click to pick a " +
      "file. Each spot's note is also a line on the card; where the panel shows no prompt box, that line is the " +
      "only place the spot appears.",
    "How work reaches a node depends on where it goes:",
    "- Into the reference list: the prompt mentions it where the proposal points at it, and a 📎 spot already " +
      "mentions its empty node.",
    "- Into one of the mode's source slots: it is not mentioned. The reader's own material still has its 📎 " +
      "note on the card; a generated result has no line. Once that node holds its file or its generated result, " +
      "the reader opens the panel of the node it feeds, presses that slot's button and clicks the node.",
    "",
    "## Document spaces",
    "- Markdown at the start of a line: `# `, `## `, `### ` for headings; a number, a full stop and a space " +
      "(`1. `) for an ordered list (on a heading it numbers the heading instead); `- `, `* ` or `+ ` for a bullet " +
      "list; `[ ] ` for a to-do (`[x] ` ticked); three backticks then a space for a code block (a language name " +
      "may go between them); `> ` for a quote, which keeps the block's type. Inside a line, `**bold**` or " +
      "`__bold__`, `*italic*` or `_italic_`, `~~struck~~` and `` `code` `` turn into that formatting, and a web " +
      "address followed by a space becomes a link. Backspace right after a Markdown change undoes it.",
    "- Shortcuts, Cmd and Option on a Mac, Ctrl and Alt elsewhere: Cmd+Alt+0 plain text, Cmd+Alt+1/2/3 headings, " +
      "Cmd+Shift+8 bullet list, Cmd+Shift+7 ordered list, Cmd+Shift+9 to-do, Cmd+Alt+C code block, Cmd+Shift+B " +
      "quote. Pressing a list's shortcut again on an item of that list turns it back to plain text; Cmd+Shift+7 " +
      "on a numbered heading takes the number off; Cmd+Shift+B again removes the quote; a heading's or code " +
      "block's own shortcut pressed again changes nothing (use Cmd+Alt+0). Cmd+B bold, Cmd+I italic, Cmd+U " +
      "underline, Cmd+Shift+S strikethrough, Cmd+E inline code. There is no shortcut for a link: select text and " +
      "paste an address over it, or use the link icon.",
    "- Keys: Enter starts a new block; in a list it starts a new item of the same kind, and on an empty item it " +
      "ends the list; in a quote the new block is quoted too; on an empty indented block it moves the block out " +
      "a level. In a code block Enter adds a line inside it, and at the end after two empty lines it leaves the " +
      "block; Shift+Enter there starts a new block below. Elsewhere Shift+Enter breaks the line inside the block. " +
      "Backspace at the start of a heading, list item, to-do or code block turns it back into plain text. Tab " +
      "indents the block under the one above (a list item becomes a nested item); a block with nothing above it " +
      "to go under just shakes. Shift+Tab moves it back out. Cmd+Shift+Up and Cmd+Shift+Down move the block up or " +
      "down. Cmd+Z undoes your own edits only; Cmd+Shift+Z or Cmd+Y redoes. Cmd+A selects the text of the block " +
      "the caret is in, and a second Cmd+A the whole document (in an empty block the first press already does). " +
      "With the whole document selected, Backspace or Delete asks " +
      `${quoted(t("spaces.document.clearConfirm.title"))} with ${quoted(t("spaces.document.clearConfirm.cancel"))} ` +
      `and ${quoted(t("spaces.document.clearConfirm.confirm"))}; typing over it or cutting it does not ask.`,
    "- Clicking the empty space below the last block starts a new block there, unless the last block is already " +
      "empty. Clicking a to-do's box ticks or unticks it. Clicking a link opens it in a new tab. Selected words " +
      "can be dragged elsewhere. Pasting Markdown turns it into headings, lists and so on (inside a code block it " +
      "stays plain text); pasting a picture or file does nothing.",
    "- Selecting text shows a bar, left to right: an icon of the current block type with a small arrow, an " +
      "alignment icon with an arrow, bold B, italic I, strikethrough S and underline U icons, a link icon, a code " +
      "icon, the letter A with an arrow (colour), a speech-bubble icon (comment), and a sparkle with the word " +
      `${quoted(t("spaces.document.commands.ai"))} and an arrow. The other buttons show no name on hover. Hovering ` +
      "the block type, alignment, colour or AI button opens its menu. Hovering the speech bubble shows " +
      `${quoted(t("spaces.document.commands.comment"))} marked not open yet. The AI menu's commands look ` +
      "available but do nothing yet. With the whole document selected there is no link icon.",
    `- The link icon opens a box, ${quoted(t("spaces.document.link.placeholder"))}, with ` +
      `${quoted(t("spaces.document.link.confirm"))}; for an address that is not one, ` +
      `${quoted(t("spaces.document.link.confirm"))} looks greyed, and pressing it or Enter shows ` +
      `${quoted(t("spaces.document.link.invalid"))} under the box. On text that is already a link, and when ` +
      "hovering a link or putting the caret in one, it shows the address, " +
      `${quoted(t("spaces.document.link.edit"))} and ${quoted(t("spaces.document.link.remove"))}. The colour ` +
      `menu has a ${quoted(t("spaces.document.commands.textColor"))} row, a ` +
      `${quoted(t("spaces.document.commands.fillColor"))} row and ` +
      `${quoted(t("spaces.document.commands.colorReset"))}.`,
    "- Hovering a line, with no text selected, shows a handle of six dots at its left. Drag it to move the " +
      `block; click it for a menu with ${quoted(t("spaces.document.commands.blockType"))}, ` +
      `${quoted(t("spaces.document.blockHandle.duplicate"))}, ` +
      `${quoted(t("spaces.document.blockHandle.insertBelow"))}, ${quoted(t("spaces.document.commands.align"))}, ` +
      `${quoted(t("spaces.document.commands.color"))}, ${quoted(t("spaces.document.commands.comment"))} (marked ` +
      `not open yet) and ${quoted(t("spaces.document.blockHandle.delete"))}; it acts on that line.`,
    `- An empty document shows ${quoted(t("spaces.document.placeholder"))}. Three dots at the top right open ` +
      `${quoted(t("spaces.document.docMenu.saveSnapshot"))} and ` +
      `${quoted(t("spaces.document.docMenu.restoreSnapshot"))}, both marked ` +
      `${quoted(t("spaces.document.docMenu.notOpenYet"))}. Other people in the document show as coloured carets ` +
      "with their names. Content written by a newer version of the editor shows as a box marked " +
      `${quoted(t("spaces.document.unsupported.label"))} and is kept as it is.`,
    "- There is no slash menu. Not available yet: comments, the AI commands, snapshots, images or other media, " +
      "tables, dividers, toggle lists, and headings below level 3.",
    "",
    "## When something is wrong",
    `- ${quoted(t("connection.banner.disconnected.text"))} across the top, with ` +
      `${quoted(t("connection.banner.reload"))}: the connection dropped, and the work area is covered until it ` +
      `comes back. ${quoted(t("connection.banner.authFailed.text"))} offers ` +
      `${quoted(t("connection.banner.authFailed.action"))}`,
    `- ${quoted(t("spaces.readOnlyNotice"))} at the top of a space, with ` +
      `${quoted(t("spaces.readOnlyReconnect"))}: too many people are editing it at once; reconnecting reloads the ` +
      "page.",
    `- Leaving the project while an upload is unfinished asks ${quoted(t("project.leaveGuard.title"))} with ` +
      `${quoted(t("project.leaveGuard.stay"))} and ${quoted(t("project.leaveGuard.leave"))}.`,
    `- A document shows ${quoted(t("spaces.document.loading"))} until it arrives; one that cannot be opened ` +
      `shows ${quoted(t("spaces.document.unavailable.text"))} with ` +
      `${quoted(t("spaces.document.unavailable.action"))}; a page older than the document editor shows ` +
      `${quoted(t("spaces.document.schemaOutdated.headline"))} with ` +
      `${quoted(t("spaces.document.schemaOutdated.action"))}.`,
    `- When this chat cannot load, it is covered with ${quoted(t("chat.load.failedTitle"))} or ` +
      `${quoted(t("chat.load.refusedTitle"))} and ${quoted(t("chat.load.retry"))}.`,
    `- ${quoted(t("canvas.upload.storageFull"))} means uploads stop until the studio frees storage.`,
  ].join("\n");
}

export const productGuide: Tool<z.infer<typeof inputSchema>, string> = tool({
  description:
    "How the reader operates our product: the top bar, the space tabs and the spaces list, this chat panel, and " +
    "on a canvas making, filling and connecting nodes, node menus, tasks, notes, moving around, the generation " +
    "panel and what is in it, source slots, focus crops, mentions, groups, placing a proposal card; writing in a " +
    "document; and what the screen shows when something goes wrong. Read it before telling the reader how to do something here: you cannot see " +
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
