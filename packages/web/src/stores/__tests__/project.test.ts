import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from '@/stores/project';

describe('useProjectStore', () => {
  beforeEach(() => {
    useProjectStore.getState().clear();
  });

  it('initial active is null', () => {
    expect(useProjectStore.getState().active).toBeNull();
  });

  it('setActive populates meta', () => {
    useProjectStore.getState().setActive({
      id: 'p1',
      name: 'Cyberpunk',
      role: 'owner',
      settings: { autoSave: true },
    });
    const a = useProjectStore.getState().active;
    expect(a?.id).toBe('p1');
    expect(a?.role).toBe('owner');
    expect(a?.settings.autoSave).toBe(true);
  });

  it('patchSettings merges into existing settings', () => {
    useProjectStore.getState().setActive({
      id: 'p1',
      name: 'X',
      role: 'edit',
      settings: { a: 1 },
    });
    useProjectStore.getState().patchSettings({ b: 2 });
    const s = useProjectStore.getState().active?.settings;
    expect(s?.a).toBe(1);
    expect(s?.b).toBe(2);
  });

  it('clear resets to null', () => {
    useProjectStore.getState().setActive({
      id: 'p1',
      name: 'X',
      role: 'view',
      settings: {},
    });
    useProjectStore.getState().clear();
    expect(useProjectStore.getState().active).toBeNull();
  });
});
