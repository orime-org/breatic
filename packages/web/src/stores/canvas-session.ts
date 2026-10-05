// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One canvas's session: the node-anchored panel it has open, the pick or note
 * tool that owns its next click, its open note boxes and its in-flight focus
 * uploads (inner#1235 §5.2). Local UI only, never Yjs.
 *
 * Every open Space tab keeps its canvas mounted and hidden, so several
 * canvases live at once and each keeps its own session: a panel open on one
 * canvas is still open when the reader comes back to it, and nothing one
 * canvas does reaches another. Everything inside a canvas reaches its store
 * by the canvas's Space id (`useCanvasSession` in `canvas-context.tsx`), and so
 * does the chrome outside it (the left menu reads the active Space's).
 */

import type { NodeType } from '@breatic/shared';
import { immer } from 'zustand/middleware/immer';
import { createStore, type StoreApi } from 'zustand/vanilla';

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
  | 'style';


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
}

/** One canvas's session state and its writers. */
export interface CanvasSessionState {
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
    | null;
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
   * Which opening of a panel this is. Every opener takes a new number, so a
   * generation submitted from one opening closes that opening only: when the
   * reader has closed the panel and opened it again meanwhile, the late answer
   * leaves the new one alone.
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
  /** Open the node-history panel for a node (#1619, replaces any open panel). */
  openHistoryPanel: (nodeId: string) => void;
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
  /** Close the panel only while it is still the opening `session` names. */
  closePanelOfSession: (session: number) => void;
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
  s.pickSession = null;
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
}

/** The two slots that read the canvas's next click. */
interface CanvasModeSlots {
  placingAnnotation: boolean;
  pickSession: PickSession | null;
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
 * @param mode - The pick to start, or `'annotation'` for the note tool.
 */
function claimTheNextClick(
  s: CanvasModeSlots,
  mode: PickSession | 'annotation',
): void {
  s.placingAnnotation = mode === 'annotation';
  s.pickSession = mode === 'annotation' ? null : mode;
}

/**
 * Create one canvas's session store.
 * @returns The store.
 */
export function createCanvasSessionStore(): CanvasSessionStore {
  return createStore<CanvasSessionState>()(
    immer((set) => ({
      placingAnnotation: false,
      annotationDrafts: {},
      panelHostId: null,
      panelKind: null,
      panelSession: 0,
      editingTextNode: null,
      taskPanelStatus: null,
      pickSession: null,
      pendingFocusUploads: [],
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
      openHistoryPanel: (nodeId) => set((s) => openPanel(s, nodeId, 'history')),
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
      closePanelOfSession: (session) =>
        set((s) => {
          if (s.panelSession === session) endPanel(s);
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
        }),
    })),
  );
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

/**
 * Whether one node's task list is the panel open beside it.
 *
 * What a selector answers is compared by identity to decide whether its
 * subscriber renders again, so a reader that only needs "open or not" asks
 * for that: reading the status through this would re-render it every time the
 * reader switches between that one node's own four tabs.
 * @param nodeId - The node to ask about.
 * @returns A selector for `useCanvasSession`.
 */
export const taskPanelOpenFor =
  (nodeId: string) =>
    (s: CanvasSessionState): boolean =>
      taskPanelStatusFor(nodeId)(s) !== null;
