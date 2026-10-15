// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One canvas's session: the node-anchored panel it has open, the pick or note
 * tool that owns its next click, its open note boxes and its in-flight focus
 * uploads (inner#1235 §5.2). Local UI only, never Yjs.
 *
 * Every open Space tab that has been on screen keeps its canvas mounted,
 * hidden while another tab is shown, so several canvases live at once and each keeps its own session: a panel open on one
 * canvas is still open when the reader comes back to it, and nothing one
 * canvas does reaches another. Everything inside a canvas reaches its store
 * by the canvas's Space id (`useCanvasSession` in `canvas-context.tsx`), and so
 * does the chrome outside it (the left menu reads the active Space's).
 */

import type { NodeType } from '@breatic/shared';
import { castDraft } from 'immer';

import { miniToolById, type MiniToolSlotValue } from '@breatic/shared/mini-tools';

import {
  EMPTY_DRAWING,
  redone,
  undone,
  withStep,
  type DrawingDraft,
  type DrawStep,
  type DrawTool,
  type MaskDisplayColor,
} from '@web/stores/drawing-draft';
import { EMPTY_EXPAND, type ExpandDraft, type ExpandView } from '@web/stores/expand-draft';
import {
  EMPTY_MARK,
  editStyleOf,
  redoneMark,
  restyled,
  undoneMark,
  withEditingText,
  withObjects,
  selectedMark,
  type MarkChannel,
  type MarkDraft,
  type MarkObject,
  type MarkTool,
} from '@web/stores/mark-draft';
import { immer } from 'zustand/middleware/immer';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { CropPreset, CropRect } from '@web/lib/crop-math';
import type { DraftState, DraftTarget } from '@web/stores/annotation-draft';

import { createSpaceRegistry } from '@web/stores/space-registry';

/**
 * The box one sticky has open, and which of its entries it belongs to.
 *
 * Kept here rather than inside the node that draws it because the canvas runs
 * with `onlyRenderVisibleElements`: panning a sticky off screen unmounts its
 * DOM, and a draft held in that component went with it -- measured on a real
 * board, two screens away and back left the box closed and half a reply gone,
 * with nothing said about it. The node is still in the document the whole
 * time, so what the reader is writing has to outlive the element as well.
 *
 * Same reason the crop marquee's target sits in `CanvasSpace` rather than in
 * the node being cropped (#1782 adversarial round 8).
 */
export interface OpenAnnotationDraft {
  readonly draft: DraftState;
  readonly target: DraftTarget;
}

/**
 * What a canvas node-pick session wires when the user clicks a node:
 *   - `reference` — an i2i source edge (clicked → target) feeding the reference
 *     rail (a connection IS a reference).
 *   - `focus` — opens a crop marquee on the clicked image node (#1782); each
 *     confirmed crop uploads a standalone copy and APPENDS it to the target's
 *     `focusImages` (no edge, no source relationship). Continuous like
 *     reference — the user may crop several regions on the SAME node and
 *     across nodes — until manual Exit.
 *   - `firstFrame` — COPIES the clicked image node's asset URL into a video
 *     node's `firstFrameUrl` (#1896), the image-to-video first frame: a
 *     pick-time snapshot with NO relationship to the source node, then the
 *     session auto-exits (single slot, unlike the continuous reference pick).
 *   - `endFrame` — the same, into `endFrameUrl` (#1904): where the first-last
 *     frame mode ends. Independent of the first frame in every way — either
 *     one can be picked or replaced at any time, and only execute asks for
 *     both (user 2026-08-10).
 *   - `characterImage` — the same, into `characterImageUrl` (#1918): one
 *     picture of a person, for both modes that animate one — the figure
 *     image animation drives, and the portrait the talking head speaks with
 *     (#1935). Its own slot rather than the first frame's, though both travel
 *     as `image`, because a pick survives a mode switch and these two mean
 *     different things.
 *   - `drivingVideo` — the same, into `drivingVideo` (#1918), but from a
 *     VIDEO node: the performance whose motion is transferred onto the
 *     character. The first SLOT pick that takes something other than an image
 *     (`reference` has always taken any node the edge rules allow), so
 *     it copies the node's poster alongside the asset — the toolbar shows a
 *     pick with an `<img>` and a video URL would paint nothing.
 *   - `drivingAudio` — the same, into `drivingAudio` (#1935), but from an
 *     AUDIO node: the track the talking head's lips follow. Stored in the
 *     same one-field shape as `drivingVideo` for the same reason, though an
 *     audio node has no poster to copy, so the toolbar keeps showing the
 *     slot's icon.
 *   - `sourceVideo` / `leftAudio` / `rightAudio` — the same, into their own
 *     fields (#2156): the clip a lipsync model redoes, and the two speakers'
 *     tracks of a two-person talking head.
 *   - `refAudio` — the same, into `refAudio` (#1960 PR2), also from an AUDIO
 *     node: the voice a cloning model speaks the new lines in. Its own slot
 *     rather than `drivingAudio`'s, though both travel as `audio`, because
 *     the two are picked on different panels for different jobs and a pick
 *     survives a mode switch.
 *   - `musicSong` / `coverSong` / `musicMelody` / `musicVocal` — more of the
 *     same into their own slots (#1960, #2156), all from AUDIO nodes: the
 *     track a new song is written after, a song to cover, a melody, a
 *     singing voice. One per role because the vendor reads each under its own
 *     name and a user may give any combination of them.
 *   - `soundVideo` / `moodImage` — the picture a sound or a score follows,
 *     from a VIDEO node, and the picture music takes its mood from, from an
 *     IMAGE node (#2156).
 */
export type PickPurpose =
  | 'reference'
  | 'focus'
  | 'firstFrame'
  | 'endFrame'
  | 'characterImage'
  | 'drivingVideo'
  | 'drivingAudio'
  | 'sourceVideo'
  | 'leftAudio'
  | 'rightAudio'
  | 'refAudio'
  | 'musicSong'
  | 'coverSong'
  | 'musicMelody'
  | 'musicVocal'
  | 'soundVideo'
  | 'moodImage'
  | 'style'
  | 'miniToolSlot';

/**
 * An in-progress "pick a node from the canvas" session. Only one is active at a
 * time — the SAME interaction (click a node, continuous until Exit, locate,
 * dim non-candidates) with two completion targets discriminated by `purpose`.
 * One source of truth, never a second parallel field per purpose.
 */
export interface PickSession {
  /** The generative node the pick feeds (the pick target). */
  nodeId: string;
  /** What clicking a node wires — a reference edge, or a copied source. */
  purpose: PickPurpose;
  /**
   * How many files the slot being filled holds, for a slot holding several
   * (inner#826): the pick keeps going until the slot is full or the reader
   * exits. Absent for every one-file slot, whose pick ends on the first click.
   */
  capacity?: number;
  /** The mini-tool slot a `miniToolSlot` pick fills (inner#888 §7.3). */
  slotKey?: string;
}

/**
 * The open mini-tool panel's draft (inner#888 §7.1). It lives and dies with
 * the panel: what the tool runs with is a snapshot of it taken on Execute.
 */
export interface MiniToolDraft {
  readonly toolId: string;
  /** The source node's content when the panel opened, to tell when it changed. */
  readonly sourceContent: string;
  readonly prompt: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly slots: Readonly<Record<string, MiniToolSlotValue | readonly MiniToolSlotValue[]>>;
  /**
   * The source's own pixel size as the crop box read it off the shown
   * element, null until it has (inner#888 §7.4.1). The crop converts between
   * the box and source pixels with it, the same size the export crops in.
   */
  readonly sourceSize: { readonly width: number; readonly height: number } | null;
  /** What the reader has drawn; null on a tool without a drawing (inner#1302 §6.1). */
  readonly drawing: DrawingDraft | null;
  /** The expand frame and its ratio; null on a tool that does not expand (inner#1303 §6.3). */
  readonly expand: ExpandDraft | null;
  /** What the reader has marked up; null on a tool that is not markup (inner#1303 §6.2). */
  readonly mark: MarkDraft | null;
  /**
   * Run was pressed and what it makes in the browser (a browser tool's file,
   * or a drawing tool's images and their upload) is being made. Only the run
   * of this opening writes it; the layer, the panel and undo read it.
   */
  readonly exporting: boolean;
}

/** The target's box as the crop box last saw it in the node. */
export interface CropFrame {
  /** Its size in the node's own layout pixels. */
  readonly width: number;
  readonly height: number;
  /** The material's own pixel size, null until the element reports it. */
  readonly natural: { readonly width: number; readonly height: number } | null;
}

/**
 * The focus crop in progress (inner#888 §7.4.1): which node is being cropped
 * and the marquee on it. One object, so the target and its marquee cannot
 * describe two nodes.
 */
export interface FocusCrop {
  readonly nodeId: string;
  /** The node's content when it was picked; a change of content ends the crop. */
  readonly content: string;
  /** The marquee as fractions (0 to 1) of the shown box, or null when none. */
  readonly rect: CropRect | null;
  /** The ratio item holding the marquee, or null when it is free. */
  readonly preset: CropPreset | null;
  /** The target's box while it is on screen, null while it is not. */
  readonly frame: CropFrame | null;
}

/** One canvas's session state and its writers. */
export interface CanvasSessionState {
  /**
   * How the open markup's canvas is told to leave a text edit or drop its
   * selection, registered by that canvas while it is mounted (inner#1303
   * §6.2). The handlers that need it run outside the canvas and cannot reach
   * its Fabric instance.
   */
  markChannel: MarkChannel | null;
  /** Register the markup canvas's channel, or null when it unmounts. */
  registerMarkChannel: (channel: MarkChannel | null) => void;
  /**
   * The colour and size the text being edited in the open markup shows
   * (`editStyleOf`), or null when no text is being edited. Read through the
   * session by the markup canvas, which loads apart from the page.
   */
  markEditStyle: () => { color: string; size: number } | null;
  /**
   * Whether the annotation tool is armed: the left menu's comment button was
   * pressed and the next canvas click says where the note goes (#1881 §6.4).
   *
   * A flag rather than a mailbox, because nothing travels — the canvas needs
   * to know the tool is up, and the click it is waiting for carries the only
   * payload there is. Nothing reaches Yjs until the note's first words do.
   */
  placingAnnotation: boolean;
  /**
   * The box each sticky has open, by node id. Empty is the ordinary case.
   * @see OpenAnnotationDraft
   */
  annotationDrafts: Record<string, OpenAnnotationDraft>;
  /**
   * Per-user node panel host: the node id whose bottom-anchored panel (Generate,
   * reset-empty-image, or node-history) is open for THIS user, or null. Local UI
   * only (never Yjs) — one collaborator opening a panel must not open it for
   * others. These panels share one host + one lifecycle and are mutually
   * exclusive (only one is ever open); `panelKind` picks which body renders. The
   * panel's collaborative content (Generate's prompt / model / params /
   * references) lives on the node itself.
   */
  panelHostId: string | null;
  /**
   * Which panel is open on `panelHostId` (null when no panel is open). A single
   * host + kind is the correct abstraction for N mutually-exclusive node-
   * anchored panels — cheaper and inherently exclusive versus parallel states.
   */
  panelKind:
    | 'generate'
    | 'generateVideo'
    | 'generateAudio'
    | 'resetEmpty'
    | 'history'
    | 'tasks'
    | 'annotation'
    | 'miniTool'
    | null;
  /** The open mini-tool panel's draft; null whenever another panel or none is open. */
  miniTool: MiniToolDraft | null;
  /** The focus crop in progress; only ever set during a focus pick. */
  focusCrop: FocusCrop | null;
  /**
   * The history entry a task row's View asked the history panel to find;
   * null whenever the history panel is not open, or was opened without one.
   */
  historyFocus: string | null;
  /**
   * Which of a node's four task states the open list is showing (#186 §7.1),
   * null whenever the task list is not the open panel.
   *
   * The list answers one state at a time, so which one was asked for belongs
   * beside the host rather than inside the panel: the counts column outside
   * the node reads it to show which of its four buttons is pressed.
   */
  taskPanelStatus: 'running' | 'done' | 'failed' | 'expired' | null;
  /**
   * Which opening of a panel this is. Every opener takes a new number, so what
   * belongs to one opening ends with it: the prompt editor built for it, and a
   * mini-tool press's exporting flag and the selection it makes once built.
   */
  panelSession: number;
  /**
   * The in-progress canvas node-pick session, or null.
   * When set, the canvas is in pick mode for `pickSession.nodeId`: clicking
   * another node wires the pick per `pickSession.purpose`, staying in the
   * session (continuous select) until Exit. Local UI only (never Yjs).
   */
  pickSession: PickSession | null;
  /**
   * Focus crops whose upload is still in flight (#1782) — local rail
   * placeholders only (never Yjs): the FocusImage copy is written to the
   * node only once the upload succeeds; a failure just drops the entry.
   */
  pendingFocusUploads: Array<{ id: string; nodeId: string; name: string }>;
  /**
   * The zoom the last canvas move ended at, or null before the first. A
   * drawing layer re-paints its bitmap at this zoom once a zoom has stopped.
   */
  settledZoom: number | null;
  /** The canvas finished moving at this zoom. */
  setSettledZoom: (zoom: number) => void;
  /**
   * Set or drop the box a sticky has open. Passing null forgets that sticky.
   * @see OpenAnnotationDraft
   */
  setAnnotationDraft: (nodeId: string, open: OpenAnnotationDraft | null) => void;
  /** Arm the annotation tool — chrome pressed the comment button. */
  startAnnotationPlacement: () => void;
  /** Disarm it: the note was placed, Escape was pressed, or the Space changed. */
  endAnnotationPlacement: () => void;
  /**
   * Open the Generate panel for a node (replaces any currently open panel).
   *
   * Image, video and audio have separate panels (#1896, #1960), and this
   * decides which one from the node's modality so callers never have to know
   * how many exist: adding text generation (#1778) is one more case here, not
   * a branch at every call site.
   */
  openGeneratePanel: (nodeId: string, type: NodeType) => void;
  /** Open the reset-empty-image panel for a node (replaces any open panel). */
  openEmptyImagePanel: (nodeId: string) => void;
  /**
   * Open the node-history panel for a node (#1619, replaces any open panel),
   * focused on one entry when a task row's View asks for it.
   */
  openHistoryPanel: (nodeId: string, focus?: string) => void;
  /**
   * Open a mini-tool's panel on a node (inner#888 §7.2). The same tool on the
   * same node keeps its draft; another tool or another node starts a new one
   * from what the caller resolved.
   */
  openMiniTool: (
    nodeId: string,
    toolId: string,
    start: { sourceContent: string; params: Readonly<Record<string, unknown>> },
  ) => void;
  /** Set one param in the open mini-tool draft. */
  setMiniToolParam: (key: string, value: unknown) => void;
  /** Set the open mini-tool draft's prompt. */
  setMiniToolPrompt: (prompt: string) => void;
  /** Fill one of the draft's slots: a single slot is replaced, a list slot appended to. */
  fillMiniToolSlot: (slotKey: string, value: MiniToolSlotValue, many: boolean) => void;
  /** Take one item out of a draft slot. */
  clearMiniToolSlot: (slotKey: string, url?: string) => void;
  /** The source changed under the open panel: reset what depends on its geometry. */
  resetMiniToolSource: (sourceContent: string, params: Readonly<Record<string, unknown>>) => void;
  /** Record the source size the crop box read off the shown element. */
  setMiniToolSourceSize: (size: { width: number; height: number }) => void;
  /**
   * Set the expand frame and its ratio, on a tool that expands. A drag says how
   * far the picture has moved; any other write that changes the frame wraps it
   * around the picture where the node shows it, and one that leaves the frame
   * as it was leaves the picture where it is.
   */
  setExpand: (next: Pick<ExpandDraft, 'frame' | 'ratio'> & { shift?: ExpandDraft['shift'] }) => void;
  /** Record where the node shows the picture, for the expand frame drawn outside it. */
  setExpandView: (view: ExpandView) => void;
  /** Pick what a press on the node does in markup. */
  setMarkTool: (tool: MarkTool) => void;
  /** Set the markup colour; the selected object takes it too. */
  setMarkColor: (color: string) => void;
  /** Set the markup size; the selected object takes it too. */
  setMarkSize: (size: number) => void;
  /** Write the markup's objects as the canvas holds them, one step when they changed. */
  commitMark: (objects: readonly MarkObject[]) => void;
  /** Take the last markup step back. */
  undoMark: () => void;
  /** Put the last undone markup step back. */
  redoMark: () => void;
  /** Remove every markup object, as one step. */
  clearMark: () => void;
  /** Record which markup object is selected. */
  selectMark: (id: string | null) => void;
  /** Record the text being edited, or null when no text is. */
  setMarkEditingText: (text: string | null) => void;
  /** Pick the shape a press on the node draws. */
  setDrawingTool: (tool: DrawTool) => void;
  /** Set the brush diameter, in percent of the source's shorter side. */
  setDrawingSize: (size: number) => void;
  /** Set the sketch ink. */
  setDrawingColor: (color: string) => void;
  /** Set the colour the mask is shown in. */
  setMaskColor: (color: MaskDisplayColor) => void;
  /** Take a drawing step: a finished stroke or shape, or a clear. */
  addDrawingStep: (step: DrawStep) => void;
  /** Take the last drawing step back. */
  undoDrawing: () => void;
  /** Put the last undone drawing step back. */
  redoDrawing: () => void;
  /**
   * Mark the open draft's run as exporting or done. Written only by the run
   * pressed in opening `session`; a later opening is left alone.
   */
  setMiniToolExporting: (exporting: boolean, session: number) => void;
  /** Make a node the focus crop target; the current target again changes nothing, null ends it. */
  setFocusTarget: (target: { nodeId: string; content: string } | null) => void;
  /** Write the marquee and the ratio item holding it. */
  setFocusMarquee: (rect: CropRect | null, preset: CropPreset | null) => void;
  /** The crop box reports the target's box; only the target's own box is written. */
  setFocusFrame: (nodeId: string, frame: CropFrame | null) => void;
  /** Start picking a node into a mini-tool slot. */
  startMiniToolSlotPick: (nodeId: string, slotKey: string, capacity?: number) => void;
  /**
   * Open one state's task list for a node (#186 §7.1, replaces any open
   * panel). Calling it again with another state re-asks the same panel.
   */
  openTaskPanel: (
    nodeId: string,
    status: 'running' | 'done' | 'failed' | 'expired',
  ) => void;
  /**
   * Expand one annotation's sticky (#1881 §8.7.3, replaces any open panel).
   *
   * The fifth node-anchored panel in the same exclusive slot, and the reason
   * "one sticky open at a time" needs no rule of its own. Local only: which
   * note this reader has open never goes into the document.
   */
  openAnnotationPanel: (nodeId: string) => void;
  /** Close whichever bottom panel is open (exit button, or execute hands off). */
  closeActivePanel: () => void;
  /**
   * Close the panel of `kind` on `nodeId`, if that is the one open. A
   * generation's answer closes the Generate panel on its node, whichever
   * opening that is (inner#1490).
   */
  closePanelOn: (nodeId: string, kind: NonNullable<CanvasSessionState['panelKind']>) => void;
  /**
   * The text node being written in, or null. Here rather than on the node:
   * one text node per canvas is written in at a time, and the reader who comes
   * back to a hidden Space is still writing (inner#1235 A13).
   */
  editingTextNode: string | null;
  /** Start writing in a text node. */
  startTextEdit: (nodeId: string) => void;
  /** Stop writing in a text node, if it is still the one being written in. */
  endTextEdit: (nodeId: string) => void;
  /** Enter a REFERENCE pick (wires i2i source edges) for a generative node. */
  startReferencePick: (nodeId: string) => void;
  /** Enter the first-frame pick for a video node (#1896). */
  startFirstFramePick: (nodeId: string) => void;
  /** Enter the end-frame pick for a video node (#1904). */
  startEndFramePick: (nodeId: string) => void;
  /** Enter the character-image pick for a video node (#1918). */
  startCharacterImagePick: (nodeId: string) => void;
  /** Enter the driving-video pick for a video node (#1918). */
  startDrivingVideoPick: (nodeId: string) => void;
  /** Enter the driving-audio pick for a video node (#1935). */
  startDrivingAudioPick: (nodeId: string) => void;
  /** Enter the source-video pick for a video node (#2156). */
  startSourceVideoPick: (nodeId: string) => void;
  /** Enter the left-speaker audio pick for a video node (#2156). */
  startLeftAudioPick: (nodeId: string) => void;
  /** Enter the right-speaker audio pick for a video node (#2156). */
  startRightAudioPick: (nodeId: string) => void;
  /** Enter the reference-audio pick for an audio node (#1960 PR2). */
  startRefAudioPick: (nodeId: string) => void;
  /** Enter the whole-song reference pick for an audio node (#1960). */
  startMusicSongPick: (nodeId: string) => void;
  /** Enter the song-to-cover pick for an audio node (#2156). */
  startCoverSongPick: (nodeId: string) => void;
  /** Enter the melody pick for an audio node (#2156). */
  startMusicMelodyPick: (nodeId: string) => void;
  /** Enter the singing-voice pick for an audio node (#2156). */
  startMusicVocalPick: (nodeId: string) => void;
  /** Enter the video pick for an audio node (#2156). */
  startSoundVideoPick: (nodeId: string) => void;
  /** Enter the mood-image pick for an audio node (#2156). */
  startMoodImagePick: (nodeId: string) => void;
  /** Start picking style images for a node; `capacity` is the model's cap (inner#826). */
  startStylePick: (nodeId: string, capacity: number) => void;
  /** Enter a FOCUS pick (#1782, crop marquee → focusImages append) for a generative node. */
  startFocusPick: (nodeId: string) => void;
  /** Add a rail placeholder for an in-flight focus-crop upload (#1782). */
  addPendingFocusUpload: (entry: { id: string; nodeId: string; name: string }) => void;
  /** Drop a focus-upload placeholder (success wrote Yjs, or failure toasted). */
  removePendingFocusUpload: (id: string) => void;
  /** Exit the current pick session (after a node is picked, or on cancel). */
  endPick: () => void;
}

/** One canvas's session store. */
export type CanvasSessionStore = StoreApi<CanvasSessionState>;

/**
 * Which Generate panel a modality opens (#1896, #1960). Image, video and audio
 * each have their own panel, so this map — not the call site — decides which
 * body renders.
 *
 * It is deliberately partial: a modality absent here has no Generate panel,
 * and `openGeneratePanel` opens nothing for it. Adding text generation (#1778)
 * means one entry here and no change anywhere else.
 */
const GENERATE_PANEL_BY_TYPE: Partial<
  Record<NodeType, 'generate' | 'generateVideo' | 'generateAudio'>
> = {
  image: 'generate',
  video: 'generateVideo',
  audio: 'generateAudio',
};

/**
 * Close whichever bottom panel is open, ending that opening: a late answer
 * to it no longer names the panel on screen.
 * @param s - The draft state being written.
 */
function endPanel(s: CanvasSessionState): void {
  s.panelHostId = null;
  s.panelKind = null;
  s.taskPanelStatus = null;
  s.miniTool = null;
  s.historyFocus = null;
  s.pickSession = null;
  s.focusCrop = null;
  s.panelSession += 1;
}

/**
 * Open a panel on a node in the canvas's one panel slot. A pick in progress
 * ends, so it cannot wire the next click to the node it was started on. Only
 * a different host or kind is a new opening: choosing the panel already open
 * again keeps it, its prompt editor and that editor's undo history.
 * @param s - The draft state being written.
 * @param nodeId - The node the panel opens on.
 * @param kind - Which panel.
 */
function openPanel(
  s: CanvasSessionState,
  nodeId: string,
  kind: NonNullable<CanvasSessionState['panelKind']>,
): void {
  if (s.panelHostId !== nodeId || s.panelKind !== kind) s.panelSession += 1;
  s.panelHostId = nodeId;
  s.panelKind = kind;
  s.pickSession = null;
  s.focusCrop = null;
  if (kind !== 'miniTool') s.miniTool = null;
  s.historyFocus = null;
}

/** The two slots that read the canvas's next click. */
interface CanvasModeSlots {
  placingAnnotation: boolean;
  pickSession: PickSession | null;
  focusCrop: FocusCrop | null;
}

/**
 * Hand the canvas's next click to one mode, and take it away from the other.
 *
 * Placing a note and picking a node are two readings of the same click, and
 * the canvas settles them by the order its handlers happen to run in — the
 * drop answers first, so a pick left standing beside an armed tool never sees
 * the click it is waiting for, and one Escape ends both. Whichever mode was
 * asked for last is the one that is on.
 *
 * Both directions come through here because the rule is one fact. Written as
 * "every opener also clears the other", it was fourteen places to keep in
 * step, and the thirteen pick openers were missing their half.
 * @param s - The draft state being written.
 * @param s.placingAnnotation - Whether the note tool is armed.
 * @param s.pickSession - The pick in progress, if any.
 * @param s.focusCrop - The crop target of the pick in progress, if any.
 * @param mode - The pick to start, or `'annotation'` for the note tool.
 */
function claimTheNextClick(
  s: CanvasModeSlots,
  mode: PickSession | 'annotation',
): void {
  s.placingAnnotation = mode === 'annotation';
  s.pickSession = mode === 'annotation' ? null : mode;
  // A crop target belongs to the focus pick it was made in.
  s.focusCrop = null;
}

/**
 * Replace the open draft's drawing.
 * @param s - The session state being written.
 * @param next - The drawing's next value from its current one.
 */
function updateDrawing(s: CanvasSessionState, next: (drawing: DrawingDraft) => DrawingDraft): void {
  if (s.miniTool?.drawing) s.miniTool = { ...s.miniTool, drawing: castDraft(next(s.miniTool.drawing)) };
}

/**
 * Apply a change to the open markup draft, when there is one.
 * @param s - The state being drafted.
 * @param next - The change.
 */
function updateMark(s: CanvasSessionState, next: (mark: MarkDraft) => MarkDraft): void {
  if (s.miniTool?.mark) s.miniTool = { ...s.miniTool, mark: castDraft(next(s.miniTool.mark as MarkDraft)) };
}

/**
 * Create one canvas's session store.
 * @returns The store.
 */
export function createCanvasSessionStore(): CanvasSessionStore {
  return createStore<CanvasSessionState>()(
    immer((set, get) => ({
      placingAnnotation: false,
      annotationDrafts: {},
      panelHostId: null,
      panelKind: null,
      panelSession: 0,
      miniTool: null,
      markChannel: null,
      registerMarkChannel: (channel) =>
        set((s) => {
          s.markChannel = channel;
        }),
      markEditStyle: () => {
        const mark = get().miniTool?.mark;
        return mark == null ? null : editStyleOf(mark);
      },
      focusCrop: null,
      historyFocus: null,
      editingTextNode: null,
      taskPanelStatus: null,
      pickSession: null,
      pendingFocusUploads: [],
      settledZoom: null,
      setSettledZoom: (zoom) =>
        set((s) => {
          s.settledZoom = zoom;
        }),
      setAnnotationDraft: (nodeId, open) =>
        set((s) => {
          if (open === null) delete s.annotationDrafts[nodeId];
          else s.annotationDrafts[nodeId] = open;
        }),
      startAnnotationPlacement: () => set((s) => claimTheNextClick(s, 'annotation')),
      endAnnotationPlacement: () =>
        set((s) => {
          s.placingAnnotation = false;
        }),
      openGeneratePanel: (nodeId, type) =>
        set((s) => {
          // Image, video and audio have separate panels (#1896, #1960).
          // Deciding here rather than at the call site keeps the number of
          // panels a detail of this store: a fourth generative modality is one
          // more entry in the map, not a new branch wherever Generate is
          // opened from.
          const kind = GENERATE_PANEL_BY_TYPE[type];
          // A modality with no panel opens nothing. The unmapped modalities are
          // the ones with no Generate panel yet (text / 3d / web / annotation /
          // group), and the menu never offers Generate on them
          // (canGenerate gates it) — so arriving here means a caller is wrong.
          // Falling back to the image panel would put such a node's host id
          // under an image body, which reads as a working panel operating on
          // the wrong thing; nothing happening is the honest outcome.
          if (!kind) return;
          openPanel(s, nodeId, kind);
        }),
      openEmptyImagePanel: (nodeId) => set((s) => openPanel(s, nodeId, 'resetEmpty')),
      openHistoryPanel: (nodeId, focus) =>
        set((s) => {
          openPanel(s, nodeId, 'history');
          s.historyFocus = focus ?? null;
        }),
      openMiniTool: (nodeId, toolId, start) =>
        set((s) => {
          const same = s.panelKind === 'miniTool' && s.panelHostId === nodeId && s.miniTool?.toolId === toolId;
          // Another tool on the same node is another panel, as far as a late
          // submit is concerned.
          if (!same && s.panelKind === 'miniTool' && s.panelHostId === nodeId) s.panelSession += 1;
          openPanel(s, nodeId, 'miniTool');
          if (!same) {
            s.miniTool = {
              toolId,
              sourceContent: start.sourceContent,
              prompt: '',
              params: { ...start.params },
              slots: {},
              sourceSize: null,
              drawing: miniToolById(toolId)?.drawing === undefined ? null : castDraft(EMPTY_DRAWING),
              expand: miniToolById(toolId)?.expand === undefined ? null : castDraft(EMPTY_EXPAND),
              mark: miniToolById(toolId)?.markup === true ? castDraft(EMPTY_MARK) : null,
              exporting: false,
            };
          }
        }),
      setMiniToolParam: (key, value) =>
        set((s) => {
          if (!s.miniTool) return;
          const params = { ...s.miniTool.params, [key]: value };
          // The cells a grid leaves out are indices of its old shape; a new
          // shape picks every cell again (inner#1303 §6.4).
          const count = miniToolById(s.miniTool.toolId)?.outputCount;
          if (count?.kind === 'product' && count.except !== undefined && count.params.includes(key)) {
            params[count.except] = [];
          }
          s.miniTool = { ...s.miniTool, params };
        }),
      setMiniToolPrompt: (prompt) =>
        set((s) => {
          if (s.miniTool) s.miniTool = { ...s.miniTool, prompt };
        }),
      fillMiniToolSlot: (slotKey, value, many) =>
        set((s) => {
          if (!s.miniTool) return;
          const held = s.miniTool.slots[slotKey];
          const next = many ? [...(Array.isArray(held) ? held : []), value] : value;
          s.miniTool = { ...s.miniTool, slots: { ...s.miniTool.slots, [slotKey]: next } };
        }),
      clearMiniToolSlot: (slotKey, url) =>
        set((s) => {
          if (!s.miniTool) return;
          const held = s.miniTool.slots[slotKey];
          const slots = { ...s.miniTool.slots };
          if (Array.isArray(held) && url !== undefined) slots[slotKey] = held.filter((item) => item.url !== url);
          else delete slots[slotKey];
          s.miniTool = { ...s.miniTool, slots };
        }),
      resetMiniToolSource: (sourceContent, params) =>
        set((s) => {
          if (s.miniTool) {
            const drawing = s.miniTool.drawing === null ? null : { ...s.miniTool.drawing, steps: [], undone: [] };
            s.miniTool = {
              ...s.miniTool,
              sourceContent,
              params: { ...s.miniTool.params, ...params },
              sourceSize: null,
              drawing,
              expand: s.miniTool.expand === null ? null : castDraft(EMPTY_EXPAND),
              // The pen stays as the reader set it; what was drawn goes.
              mark:
                s.miniTool.mark === null
                  ? null
                  : castDraft({ ...EMPTY_MARK, tool: s.miniTool.mark.tool, color: s.miniTool.mark.color, size: s.miniTool.mark.size }),
            };
          }
        }),
      setExpand: (next) =>
        set((s) => {
          const held = s.miniTool?.expand;
          if (s.miniTool && held) {
            const same = JSON.stringify(held.frame) === JSON.stringify(next.frame);
            const shift = next.shift ?? (same ? held.shift : EMPTY_EXPAND.shift);
            s.miniTool = {
              ...s.miniTool,
              expand: castDraft({ ...held, frame: { ...next.frame }, ratio: next.ratio, shift: { ...shift } }),
            };
          }
        }),
      setExpandView: (view) =>
        set((s) => {
          if (s.miniTool?.expand && JSON.stringify(s.miniTool.expand.view) !== JSON.stringify(view)) {
            s.miniTool = { ...s.miniTool, expand: castDraft({ ...s.miniTool.expand, view }) };
          }
        }),
      // A drawing tool lets go of the selected object, so the next colour or
      // size is the next object's (inner#1303 §6.6).
      setMarkTool: (tool) =>
        set((s) => updateMark(s, (m) => ({ ...m, tool, selectedId: tool === 'select' ? m.selectedId : null }))),
      setMarkColor: (color) => set((s) => updateMark(s, (m) => restyled(m, { color }))),
      setMarkSize: (size) => set((s) => updateMark(s, (m) => restyled(m, { size }))),
      commitMark: (objects) => set((s) => updateMark(s, (m) => withObjects(m, objects))),
      undoMark: () => set((s) => updateMark(s, undoneMark)),
      redoMark: () => set((s) => updateMark(s, redoneMark)),
      clearMark: () =>
        set((s) => updateMark(s, (m) => ({ ...withObjects(m, []), selectedId: null }))),
      selectMark: (id) => set((s) => updateMark(s, (m) => selectedMark(m, id))),
      setMarkEditingText: (text) => set((s) => updateMark(s, (m) => withEditingText(m, text))),
      setMiniToolSourceSize: (size) =>
        set((s) => {
          if (s.miniTool) s.miniTool = { ...s.miniTool, sourceSize: { width: size.width, height: size.height } };
        }),
      setDrawingTool: (tool) => set((s) => updateDrawing(s, (d) => ({ ...d, tool }))),
      setDrawingSize: (size) => set((s) => updateDrawing(s, (d) => ({ ...d, size }))),
      setDrawingColor: (color) => set((s) => updateDrawing(s, (d) => ({ ...d, color }))),
      setMaskColor: (maskColor) => set((s) => updateDrawing(s, (d) => ({ ...d, maskColor }))),
      addDrawingStep: (step) => set((s) => updateDrawing(s, (d) => withStep(d, step))),
      undoDrawing: () => set((s) => updateDrawing(s, undone)),
      redoDrawing: () => set((s) => updateDrawing(s, redone)),
      setMiniToolExporting: (exporting, session) =>
        set((s) => {
          if (s.miniTool !== null && s.panelSession === session) s.miniTool = { ...s.miniTool, exporting };
        }),
      setFocusTarget: (target) =>
        set((s) => {
          if (target === null) {
            s.focusCrop = null;
            return;
          }
          // A click on the target itself reaches here too; it keeps the marquee.
          if (s.focusCrop?.nodeId === target.nodeId) return;
          s.focusCrop = { nodeId: target.nodeId, content: target.content, rect: null, preset: null, frame: null };
        }),
      setFocusMarquee: (rect, preset) =>
        set((s) => {
          if (s.focusCrop) s.focusCrop = { ...s.focusCrop, rect, preset };
        }),
      setFocusFrame: (nodeId, frame) =>
        set((s) => {
          if (s.focusCrop?.nodeId === nodeId) s.focusCrop = { ...s.focusCrop, frame };
        }),
      startMiniToolSlotPick: (nodeId, slotKey, capacity) =>
        set((s) =>
          claimTheNextClick(s, {
            nodeId,
            purpose: 'miniToolSlot',
            slotKey,
            ...(capacity !== undefined && { capacity }),
          }),
        ),
      openTaskPanel: (nodeId, status) =>
        set((s) => {
          openPanel(s, nodeId, 'tasks');
          s.taskPanelStatus = status;
        }),
      openAnnotationPanel: (nodeId) => set((s) => openPanel(s, nodeId, 'annotation')),
      closeActivePanel: () => set(endPanel),
      startTextEdit: (nodeId) =>
        set((s) => {
          s.editingTextNode = nodeId;
        }),
      endTextEdit: (nodeId) =>
        set((s) => {
          if (s.editingTextNode === nodeId) s.editingTextNode = null;
        }),
      closePanelOn: (nodeId, kind) =>
        set((s) => {
          if (s.panelHostId === nodeId && s.panelKind === kind) endPanel(s);
        }),
      startReferencePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'reference' })),
      startFirstFramePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'firstFrame' })),
      startEndFramePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'endFrame' })),
      startCharacterImagePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'characterImage' })),
      startDrivingVideoPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'drivingVideo' })),
      startDrivingAudioPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'drivingAudio' })),
      startSourceVideoPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'sourceVideo' })),
      startLeftAudioPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'leftAudio' })),
      startRightAudioPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'rightAudio' })),
      startRefAudioPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'refAudio' })),
      startMusicSongPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'musicSong' })),
      startCoverSongPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'coverSong' })),
      startMusicMelodyPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'musicMelody' })),
      startMusicVocalPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'musicVocal' })),
      startSoundVideoPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'soundVideo' })),
      startMoodImagePick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'moodImage' })),
      startStylePick: (nodeId, capacity) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'style', capacity })),
      startFocusPick: (nodeId) => set((s) => claimTheNextClick(s, { nodeId, purpose: 'focus' })),
      addPendingFocusUpload: (entry) =>
        set((s) => {
          s.pendingFocusUploads.push(entry);
        }),
      removePendingFocusUpload: (id) =>
        set((s) => {
          s.pendingFocusUploads = s.pendingFocusUploads.filter(
            (p) => p.id !== id,
          );
        }),
      endPick: () =>
        set((s) => {
          s.pickSession = null;
          s.focusCrop = null;
        }),
    })),
  );
}

/**
 * A selector for the mini-tool draft open on this node: its panel is open on
 * the node and no slot pick is under way. Every layer on the node reads it, so
 * they agree on when they are shown.
 * @param nodeId - The node.
 * @returns The selector, answering the draft or null.
 */
export function miniToolOpenOn(nodeId: string | null): (s: CanvasSessionState) => MiniToolDraft | null {
  return (s) => (s.panelKind === 'miniTool' && s.panelHostId === nodeId && s.pickSession === null ? s.miniTool : null);
}

/**
 * Canvas sessions live as long as their Space's tab: created on first use,
 * dropped when the tab is closed, all cleared when the project is left.
 */
export const canvasSessions = createSpaceRegistry<CanvasSessionStore>(createCanvasSessionStore);

/**
 * Which task state one node's own list is open on, or null.
 *
 * Null covers both "some other panel is open" and "this one is not open at
 * all". `panelKind` is read first because only `openTaskPanel` ever sets
 * `taskPanelStatus` and only the close paths clear it: the four other openers
 * take the host slot and leave the status behind, so a stale one would answer
 * for a panel that is no longer the task list.
 *
 * Two places ask this and have to agree — the node body, deciding whether the
 * error box steps aside for what the node holds, and the node menu, deciding
 * whether Download has anything to hand over.
 * @param nodeId - The node to ask about.
 * @returns A selector for `useCanvasSession`.
 */
export const taskPanelStatusFor =
  (nodeId: string) =>
    (s: CanvasSessionState): CanvasSessionState['taskPanelStatus'] =>
      s.panelKind === 'tasks' && s.panelHostId === nodeId
        ? s.taskPanelStatus
        : null;
