// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { readAgentPanelOpen, writeAgentPanelOpen } from '@web/lib/project-tabs-storage';

/**
 * Global UI store - chrome-level state shared across pages.
 *
 * Scope:
 *   - chatPanelCollapsed: Agent panel hidden, remembered per account and project
 *   - drawerOpen: side drawer state (Space drawer, conversation history)
 *   - sidebarOpen: studio nav sidebar
 *   - modalStack: ordered list of open modal ids (top of stack is active)
 *
 * Yjs source-of-truth data does NOT live here.
 */
/**
 * The two regions a project page is split into. The space region holds the
 * tab bar and every space under it; the agent region is the chat column.
 */
export type ActiveRegion = 'space' | 'agent';

/** The account and project the Agent panel state is stored under. */
interface AgentPanelOwner {
  userId: string;
  projectId: string;
}

interface UIState {
  /**
   * Whether the Agent panel is hidden. Remembered per account and project:
   * `restoreAgentPanel` loads it when a project page opens, and every change
   * after that is stored under the same account and project.
   */
  chatPanelCollapsed: boolean;
  /** Where changes to `chatPanelCollapsed` are stored; null before a project opens. */
  agentPanelOwner: AgentPanelOwner | null;
  drawerOpen: boolean;
  sidebarOpen: boolean;
  modalStack: string[];
  /** Share popover open state - controlled so other surfaces can open it. */
  shareOpen: boolean;
  /** Members management modal open state. */
  // membersModalOpen removed 2026-05-25: superseded by activeOverlayId
  // exclusive overlay (MembersModal uses useExclusiveOverlay('members-modal')).
  /**
   * Loading overlay phase for Space-level operations. `null` = no overlay.
   * `"creating"` = waiting for server-published create event to propagate
   * through collab → Y.Doc → WS. `"deleting"` = same flow for soft-delete.
   * The overlay sits above the Project page and blocks duplicate clicks
   * during the round trip; auto-dismisses on Y.Doc sync or after the
   * 10-second safety timeout.
   */
  spaceOpInProgress: null | 'creating' | 'deleting';
  /**
   * Space id currently being previewed in the read-only sheet (drawer
   * "View" action). `null` = sheet closed.
   */
  readOnlyViewSpaceId: string | null;
  /**
   * Currently visible Sheet / Dialog id. There may only be one open
   * at a time per the design rule "Sheet/Dialog default to non-modal +
   * globally exclusive" (2026-05-25). Switching to a new overlay automatically
   * closes the previously active one (each consumer's
   * `useExclusiveOverlay(id)` watches this and clears its own open
   * state when `activeOverlayId !== id`).
   */
  activeOverlayId: string | null;
  /**
   * Which of the two regions the user is working in. Three things hand it
   * over: a pointer press inside a region, focus entering it, and a file
   * dropped into it — the last one because a drag from the desktop presses no
   * pointer down on the page and moves no focus. Nothing else does: focus
   * going to the top bar, to an overlay, or out of the window leaves it alone,
   * and so does the wheel.
   *
   * Read by the canvas keyboard and clipboard gates and by the active-state
   * colours, so that what the screen says and what the keys do cannot drift
   * apart.
   */
  activeRegion: ActiveRegion;
  /**
   * Load what this account left in this project, open when nothing is stored,
   * and store later changes there.
   */
  restoreAgentPanel: (userId: string | undefined, projectId: string) => void;
  setChatPanelCollapsed: (collapsed: boolean) => void;
  toggleChatPanel: () => void;
  setDrawerOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  pushModal: (id: string) => void;
  popModal: () => void;
  setShareOpen: (open: boolean) => void;
  // setMembersModalOpen removed - use setActiveOverlayId('members-modal')
  setSpaceOpInProgress: (op: UIState['spaceOpInProgress']) => void;
  setReadOnlyViewSpaceId: (id: string | null) => void;
  setActiveOverlayId: (id: string | null) => void;
  setActiveRegion: (region: ActiveRegion) => void;
  /** Reset per-project chrome session state (overlays / modals / share / drawer); keeps layout prefs (#1771). */
  reset: () => void;
}

/**
 * Store the panel state under whoever the panel was last restored for.
 * @param owner - The account and project, or null before a project opens.
 * @param collapsed - Whether the panel is now hidden.
 */
function storeAgentPanel(owner: AgentPanelOwner | null, collapsed: boolean): void {
  if (owner !== null) writeAgentPanelOpen(owner.userId, owner.projectId, !collapsed);
}

export const useUIStore = create<UIState>()(
  immer((set, get) => ({
    chatPanelCollapsed: false,
    agentPanelOwner: null,
    drawerOpen: false,
    sidebarOpen: true,
    modalStack: [],
    shareOpen: false,
    // (membersModalOpen field removed - see activeOverlayId)
    spaceOpInProgress: null,
    readOnlyViewSpaceId: null,
    activeOverlayId: null,
    activeRegion: 'space',
    restoreAgentPanel: (userId, projectId) =>
      set((s) => {
        s.chatPanelCollapsed = readAgentPanelOpen(userId, projectId) === false;
        s.agentPanelOwner = userId === undefined || userId === '' ? null : { userId, projectId };
      }),
    setChatPanelCollapsed: (collapsed) => {
      set((s) => {
        s.chatPanelCollapsed = collapsed;
      });
      storeAgentPanel(get().agentPanelOwner, collapsed);
    },
    toggleChatPanel: () => {
      set((s) => {
        s.chatPanelCollapsed = !s.chatPanelCollapsed;
      });
      const { agentPanelOwner, chatPanelCollapsed } = get();
      storeAgentPanel(agentPanelOwner, chatPanelCollapsed);
    },
    setDrawerOpen: (open) =>
      set((s) => {
        s.drawerOpen = open;
      }),
    setSidebarOpen: (open) =>
      set((s) => {
        s.sidebarOpen = open;
      }),
    pushModal: (id) =>
      set((s) => {
        s.modalStack.push(id);
      }),
    popModal: () =>
      set((s) => {
        s.modalStack.pop();
      }),
    setShareOpen: (open) =>
      set((s) => {
        s.shareOpen = open;
      }),
    // setMembersModalOpen removed - see setActiveOverlayId('members-modal')
    setSpaceOpInProgress: (op) =>
      set((s) => {
        s.spaceOpInProgress = op;
      }),
    setReadOnlyViewSpaceId: (id) =>
      set((s) => {
        s.readOnlyViewSpaceId = id;
      }),
    setActiveOverlayId: (id) =>
      set((s) => {
        s.activeOverlayId = id;
      }),
    setActiveRegion: (region) =>
      set((s) => {
        s.activeRegion = region;
      }),
    reset: () =>
      set((s) => {
        s.drawerOpen = false;
        s.modalStack = [];
        s.shareOpen = false;
        s.spaceOpInProgress = null;
        s.readOnlyViewSpaceId = null;
        s.activeOverlayId = null;
        // A fresh project opens with the space region in charge (2026-08-26).
        s.activeRegion = 'space';
        // `sidebarOpen` is kept across a project change; `chatPanelCollapsed`
        // is loaded for the next project by `restoreAgentPanel`.
      }),
  })),
);
