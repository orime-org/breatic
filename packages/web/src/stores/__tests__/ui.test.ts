import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '@web/stores/ui';

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      chatPanelCollapsed: false,
      drawerOpen: false,
      sidebarOpen: true,
      modalStack: [],
      shareOpen: false,
      activeOverlayId: null,
    });
  });

  it('initial state has chat panel open, drawer closed, sidebar open', () => {
    const s = useUIStore.getState();
    expect(s.chatPanelCollapsed).toBe(false);
    expect(s.drawerOpen).toBe(false);
    expect(s.sidebarOpen).toBe(true);
    expect(s.modalStack).toEqual([]);
  });

  it('toggleChatPanel flips collapsed state', () => {
    useUIStore.getState().toggleChatPanel();
    expect(useUIStore.getState().chatPanelCollapsed).toBe(true);
    useUIStore.getState().toggleChatPanel();
    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
  });

  it('pushModal / popModal manages stack LIFO', () => {
    useUIStore.getState().pushModal('a');
    useUIStore.getState().pushModal('b');
    expect(useUIStore.getState().modalStack).toEqual(['a', 'b']);
    useUIStore.getState().popModal();
    expect(useUIStore.getState().modalStack).toEqual(['a']);
  });

  it('setShareOpen toggles share state independently', () => {
    const s = useUIStore.getState();
    expect(s.shareOpen).toBe(false);
    s.setShareOpen(true);
    expect(useUIStore.getState().shareOpen).toBe(true);
  });

  it('setActiveOverlayId enforces single-overlay rule', () => {
    expect(useUIStore.getState().activeOverlayId).toBeNull();
    useUIStore.getState().setActiveOverlayId('space-drawer');
    expect(useUIStore.getState().activeOverlayId).toBe('space-drawer');
    // Opening a new overlay replaces the previous one — single-source.
    useUIStore.getState().setActiveOverlayId('new-space-dialog');
    expect(useUIStore.getState().activeOverlayId).toBe('new-space-dialog');
    useUIStore.getState().setActiveOverlayId(null);
    expect(useUIStore.getState().activeOverlayId).toBeNull();
  });
});
