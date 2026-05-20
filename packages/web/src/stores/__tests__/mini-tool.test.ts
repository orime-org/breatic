import { describe, it, expect, beforeEach } from 'vitest';
import { useMiniToolStore } from '@/stores/mini-tool';

describe('useMiniToolStore', () => {
  beforeEach(() => {
    useMiniToolStore.setState({ sessions: {} });
  });

  it('starts a session keyed by sourceNodeId', () => {
    useMiniToolStore.getState().startSession({
      sessionId: 's1',
      sourceNodeId: 'n1',
      toolName: 'remove-bg',
    });
    const s = useMiniToolStore.getState().sessions['n1'];
    expect(s.toolName).toBe('remove-bg');
    expect(s.status).toBe('previewing');
    expect(s.progress).toBe(0);
  });

  it('updateSession patches partial fields', () => {
    useMiniToolStore.getState().startSession({
      sessionId: 's1',
      sourceNodeId: 'n1',
      toolName: 'upscale',
    });
    useMiniToolStore
      .getState()
      .updateSession('n1', { status: 'submitting', progress: 42 });
    const s = useMiniToolStore.getState().sessions['n1'];
    expect(s.status).toBe('submitting');
    expect(s.progress).toBe(42);
  });

  it('endSession removes the entry', () => {
    useMiniToolStore.getState().startSession({
      sessionId: 's1',
      sourceNodeId: 'n1',
      toolName: 'remove-bg',
    });
    useMiniToolStore.getState().endSession('n1');
    expect(useMiniToolStore.getState().sessions['n1']).toBeUndefined();
  });
});
