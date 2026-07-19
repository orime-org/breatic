// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Global UI store - chrome-level state shared across pages.
 *
 * Scope:
 *   - chatPanelCollapsed: chat panel collapse state
 *   - drawerOpen: side drawer state (Space drawer, conversation history)
 *   - sidebarOpen: studio nav sidebar
 *   - modalStack: ordered list of open modal ids (top of stack is active)
 *
 * Yjs source-of-truth data does NOT live here.
 */
interface UIState {
  chatPanelCollapsed: boolean;
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
  /** Reset per-project chrome session state (overlays / modals / share / drawer); keeps layout prefs (#1771). */
  reset: () => void;
}

export const useUIStore = create<UIState>()(
  immer((set) => ({
    chatPanelCollapsed: false,
    drawerOpen: false,
    sidebarOpen: true,
    modalStack: [],
    shareOpen: false,
    // (membersModalOpen field removed - see activeOverlayId)
    spaceOpInProgress: null,
    readOnlyViewSpaceId: null,
    activeOverlayId: null,
    setChatPanelCollapsed: (collapsed) =>
      set((s) => {
        s.chatPanelCollapsed = collapsed;
      }),
    toggleChatPanel: () =>
      set((s) => {
        s.chatPanelCollapsed = !s.chatPanelCollapsed;
      }),
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
    reset: () =>
      set((s) => {
        s.drawerOpen = false;
        s.modalStack = [];
        s.shareOpen = false;
        s.spaceOpInProgress = null;
        s.readOnlyViewSpaceId = null;
        s.activeOverlayId = null;
        // `sidebarOpen` / `chatPanelCollapsed` are layout preferences, not
        // per-project session state — deliberately kept across a project change.
      }),
  })),
);
