import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '@/stores/ui';

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      chatPanelCollapsed: false,
      drawerOpen: false,
      sidebarOpen: true,
      modalStack: [],
      shareOpen: false,
      membersModalOpen: false,
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

  it('setShareOpen / setMembersModalOpen toggle independent state', () => {
    const s = useUIStore.getState();
    expect(s.shareOpen).toBe(false);
    expect(s.membersModalOpen).toBe(false);
    s.setShareOpen(true);
    expect(useUIStore.getState().shareOpen).toBe(true);
    expect(useUIStore.getState().membersModalOpen).toBe(false);
    useUIStore.getState().setMembersModalOpen(true);
    expect(useUIStore.getState().shareOpen).toBe(true);
    expect(useUIStore.getState().membersModalOpen).toBe(true);
  });
});
