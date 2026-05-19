import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Global UI store — chrome-level state shared across pages.
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
  setChatPanelCollapsed: (collapsed: boolean) => void;
  toggleChatPanel: () => void;
  setDrawerOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  pushModal: (id: string) => void;
  popModal: () => void;
}

export const useUIStore = create<UIState>()(
  immer((set) => ({
    chatPanelCollapsed: false,
    drawerOpen: false,
    sidebarOpen: true,
    modalStack: [],
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
  })),
);
