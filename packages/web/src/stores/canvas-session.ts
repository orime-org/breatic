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

import type { OpenAnnotationDraft, PickSession } from '@web/stores/canvas';

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
          s.panelHostId = nodeId;
          s.panelKind = kind;
          s.panelSession += 1;
          // Switching the panel to another node (or from the reset panel) must
          // exit any in-progress pick — otherwise a stale pick would wire the
          // next click to the PREVIOUS node (closeActivePanel clears it too).
          s.pickSession = null;
        }),
      openEmptyImagePanel: (nodeId) =>
        set((s) => {
          // Opening reset replaces any open panel (Generate included) — single
          // host + kind makes the two mutually exclusive with no manual bookkeeping.
          s.panelHostId = nodeId;
          s.panelKind = 'resetEmpty';
          s.panelSession += 1;
          s.pickSession = null;
        }),
      openHistoryPanel: (nodeId) =>
        set((s) => {
          // History browse is another node-anchored panel in the same mutually-
          // exclusive slot; clearing pickSession matches the other two openers so
          // a stale Generate pick can't wire the next click to a previous node.
          s.panelHostId = nodeId;
          s.panelKind = 'history';
          s.panelSession += 1;
          s.pickSession = null;
        }),
      openTaskPanel: (nodeId, status) =>
        set((s) => {
          // The fourth node-anchored panel in the same exclusive slot; clearing
          // pickSession matches the other three openers so a stale Generate pick
          // cannot wire the next click to a previous node.
          s.panelHostId = nodeId;
          s.panelKind = 'tasks';
          s.panelSession += 1;
          s.taskPanelStatus = status;
          s.pickSession = null;
        }),
      openAnnotationPanel: (nodeId) =>
        set((s) => {
          // The fifth panel in the exclusive slot; clearing pickSession matches
          // the other four openers so a stale Generate pick cannot wire the next
          // click to a previous node.
          s.panelHostId = nodeId;
          s.panelKind = 'annotation';
          s.panelSession += 1;
          s.pickSession = null;
        }),
      closeActivePanel: () =>
        set((s) => {
          s.panelHostId = null;
          s.panelKind = null;
          s.taskPanelStatus = null;
          s.pickSession = null;
        }),
      closePanelOfSession: (session) =>
        set((s) => {
          if (s.panelSession !== session) return;
          s.panelHostId = null;
          s.panelKind = null;
          s.taskPanelStatus = null;
          s.pickSession = null;
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

/** Every open Space's canvas session, by Space id. */
const sessions = new Map<string, CanvasSessionStore>();

/**
 * Canvas sessions live as long as their Space's tab: created on first use,
 * dropped when the tab is closed, all cleared when the project is left.
 */
export const canvasSessions = {
  /**
   * The session of a Space, created on first use.
   * @param spaceId - The Space.
   * @returns Its store; the same one until the Space is dropped.
   */
  of(spaceId: string): CanvasSessionStore {
    let store = sessions.get(spaceId);
    if (store === undefined) {
      store = createCanvasSessionStore();
      sessions.set(spaceId, store);
    }
    return store;
  },
  /**
   * Forget a Space's session, when its tab is closed.
   * @param spaceId - The Space.
   */
  drop(spaceId: string): void {
    sessions.delete(spaceId);
  },
  /** Forget every session, when the project is left. */
  clear(): void {
    sessions.clear();
  },
};

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
