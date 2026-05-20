import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '@/stores/ui';

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      chatPanelCollapsed: false,
      drawerOpen: false,
      sidebarOpen: true,
      modalStack: [],
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
});
