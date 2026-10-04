// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One canvas's session: the node-anchored panel it has open, the pick or note
 * tool that owns its next click, its open note boxes and its in-flight focus
 * uploads (inner#1235 §5.2).
 *
 * Every open Space tab keeps its canvas mounted and hidden, so several
 * canvases live at once and each keeps its own session: a panel open on one
 * canvas is still open when the reader comes back to it, and nothing one
 * canvas does reaches another. A canvas provides its store through
 * `CanvasSessionContext`; chrome outside any canvas (the left menu) reaches the
 * active one through `canvasSessions`, keyed by Space id.
 */

import type { NodeType } from '@breatic/shared';
import * as React from 'react';
import { useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { OpenAnnotationDraft, PickSession } from '@web/stores/canvas';

/** Which node-anchored panel is open. */
export type CanvasPanelKind =
  | 'generate'
  | 'generateVideo'
  | 'generateAudio'
  | 'resetEmpty'
  | 'history'
  | 'tasks'
  | 'annotation';

/** Which of a node's four task states its open list shows. */
export type TaskPanelStatus = 'running' | 'done' | 'failed' | 'expired';

/** A pick a panel can start, by its purpose. */
type PickPurposeWithoutCapacity = Exclude<PickSession['purpose'], 'style'>;

export interface CanvasSessionState {
  /** The node whose panel is open, or null. */
  panelHostId: string | null;
  /** Which panel is open on `panelHostId`, or null. */
  panelKind: CanvasPanelKind | null;
  /**
   * Which opening of a panel this is. Every open takes a new number, so a
   * generation submitted from one opening closes that opening only: if the
   * reader closed and reopened the panel meanwhile, the late answer leaves
   * the new one alone.
   */
  panelSession: number;
  /** Which task state the open task list shows, or null. */
  taskPanelStatus: TaskPanelStatus | null;
  /** The pick in progress, or null. */
  pickSession: PickSession | null;
  /** Whether the note tool owns the next click. */
  placingAnnotation: boolean;
  /** The box each note has open, by node id. */
  annotationDrafts: Record<string, OpenAnnotationDraft>;
  /** Focus crops whose upload is still in flight. */
  pendingFocusUploads: Array<{ id: string; nodeId: string; name: string }>;
  /** Open the Generate panel a node's modality has; nothing for one without. */
  openGeneratePanel: (nodeId: string, type: NodeType) => void;
  /** Open the reset-empty-image panel. */
  openEmptyImagePanel: (nodeId: string) => void;
  /** Open the node-history panel. */
  openHistoryPanel: (nodeId: string) => void;
  /** Open one state's task list. */
  openTaskPanel: (nodeId: string, status: TaskPanelStatus) => void;
  /** Expand one note. */
  openAnnotationPanel: (nodeId: string) => void;
  /** Close whichever panel is open. */
  closeActivePanel: () => void;
  /** Close the panel only if it is still the opening `session` named. */
  closePanelOfSession: (session: number) => void;
  /** Start a pick for a node. */
  startPick: (nodeId: string, purpose: PickPurposeWithoutCapacity) => void;
  /** Start picking style images; `capacity` is the model's cap. */
  startStylePick: (nodeId: string, capacity: number) => void;
  /** End the pick in progress. */
  endPick: () => void;
  /** Arm the note tool. */
  startAnnotationPlacement: () => void;
  /** Disarm the note tool. */
  endAnnotationPlacement: () => void;
  /** Set or drop the box a note has open. */
  setAnnotationDraft: (nodeId: string, open: OpenAnnotationDraft | null) => void;
  /** Add a placeholder for an in-flight focus-crop upload. */
  addPendingFocusUpload: (entry: { id: string; nodeId: string; name: string }) => void;
  /** Drop a focus-upload placeholder. */
  removePendingFocusUpload: (id: string) => void;
}

/** One canvas's session store. */
export type CanvasSessionStore = StoreApi<CanvasSessionState>;

/** Which Generate panel a modality opens; a modality absent here has none. */
const GENERATE_PANEL_BY_TYPE: Partial<
  Record<NodeType, 'generate' | 'generateVideo' | 'generateAudio'>
> = {
  image: 'generate',
  video: 'generateVideo',
  audio: 'generateAudio',
};

/** The two slots that read the canvas's next click. */
interface NextClickSlots {
  placingAnnotation: boolean;
  pickSession: PickSession | null;
}

/**
 * Hand the canvas's next click to the note tool or to a pick.
 *
 * Both answer the same click, and the one that arms first would answer it
 * while the other waits for a click that never comes, so they are one fact:
 * this is the only place either is armed.
 * @param s - The draft being written.
 * @param mode - The pick to start, or `'annotation'` for the note tool.
 */
function claimTheNextClick(
  s: NextClickSlots,
  mode: PickSession | 'annotation',
): void {
  s.placingAnnotation = mode === 'annotation';
  s.pickSession = mode === 'annotation' ? null : mode;
}

/** The fields a panel open writes. */
interface PanelSlots {
  panelHostId: string | null;
  panelKind: CanvasPanelKind | null;
  panelSession: number;
  pickSession: PickSession | null;
}

/**
 * Open a panel in the one exclusive slot. A pick in progress ends with it, so
 * a stale pick cannot wire the next click to the node the reader left.
 * @param s - The draft being written.
 * @param nodeId - The node the panel opens on.
 * @param kind - Which panel.
 */
function openPanel(s: PanelSlots, nodeId: string, kind: CanvasPanelKind): void {
  s.panelHostId = nodeId;
  s.panelKind = kind;
  s.panelSession += 1;
  s.pickSession = null;
}

/**
 * Create one canvas's session store.
 * @returns The store.
 */
export function createCanvasSessionStore(): CanvasSessionStore {
  return createStore<CanvasSessionState>()(
    immer((set) => ({
      panelHostId: null,
      panelKind: null,
      panelSession: 0,
      taskPanelStatus: null,
      pickSession: null,
      placingAnnotation: false,
      annotationDrafts: {},
      pendingFocusUploads: [],
      openGeneratePanel: (nodeId, type) =>
        set((s) => {
          const kind = GENERATE_PANEL_BY_TYPE[type];
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
      closeActivePanel: () =>
        set((s) => {
          s.panelHostId = null;
          s.panelKind = null;
          s.taskPanelStatus = null;
          s.pickSession = null;
        }),
      closePanelOfSession: (session) =>
        set((s) => {
          if (s.panelSession !== session || s.panelKind === null) return;
          s.panelHostId = null;
          s.panelKind = null;
          s.taskPanelStatus = null;
          s.pickSession = null;
        }),
      startPick: (nodeId, purpose) =>
        set((s) => claimTheNextClick(s, { nodeId, purpose })),
      startStylePick: (nodeId, capacity) =>
        set((s) => claimTheNextClick(s, { nodeId, purpose: 'style', capacity })),
      endPick: () =>
        set((s) => {
          s.pickSession = null;
        }),
      startAnnotationPlacement: () => set((s) => claimTheNextClick(s, 'annotation')),
      endAnnotationPlacement: () =>
        set((s) => {
          s.placingAnnotation = false;
        }),
      setAnnotationDraft: (nodeId, open) =>
        set((s) => {
          if (open === null) delete s.annotationDrafts[nodeId];
          else s.annotationDrafts[nodeId] = open;
        }),
      addPendingFocusUpload: (entry) =>
        set((s) => {
          s.pendingFocusUploads.push(entry);
        }),
      removePendingFocusUpload: (id) =>
        set((s) => {
          s.pendingFocusUploads = s.pendingFocusUploads.filter((p) => p.id !== id);
        }),
    })),
  );
}

/** The session of the canvas a component renders inside. */
export const CanvasSessionContext = React.createContext<CanvasSessionStore | null>(null);

/**
 * The session store of the canvas this component renders inside.
 * @returns The store.
 * @throws {Error} When rendered outside a canvas.
 */
export function useCanvasSessionStore(): CanvasSessionStore {
  const store = React.useContext(CanvasSessionContext);
  if (store === null) throw new Error('useCanvasSessionStore outside a canvas');
  return store;
}

/**
 * Read a slice of the session of the canvas this component renders inside.
 * @param selector - What to read.
 * @returns The slice.
 */
export function useCanvasSession<T>(selector: (s: CanvasSessionState) => T): T {
  return useStore(useCanvasSessionStore(), selector);
}

/** Every mounted canvas's session, by Space id. */
const registered = new Map<string, CanvasSessionStore>();

/** The session stores of mounted canvases, for chrome outside any canvas. */
export const canvasSessions = {
  /**
   * Record a canvas's store under its Space id.
   * @param spaceId - The Space the canvas shows.
   * @param store - Its session store.
   * @returns A function that removes the record, if it is still this store.
   */
  register(spaceId: string, store: CanvasSessionStore): () => void {
    registered.set(spaceId, store);
    return () => {
      if (registered.get(spaceId) === store) registered.delete(spaceId);
    };
  },
  /**
   * The store recorded for a Space.
   * @param spaceId - The Space.
   * @returns Its store, or undefined when no canvas for it is mounted.
   */
  get(spaceId: string): CanvasSessionStore | undefined {
    return registered.get(spaceId);
  },
  /** Forget every record. */
  clear(): void {
    registered.clear();
  },
};
