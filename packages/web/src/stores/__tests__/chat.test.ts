import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '@/stores/chat';

describe('useChatStore', () => {
  beforeEach(() => {
    useChatStore.setState({
      composerDraft: '',
      activeConversationId: null,
      streaming: false,
    });
  });

  it('initial state is empty draft, no conversation, not streaming', () => {
    const s = useChatStore.getState();
    expect(s.composerDraft).toBe('');
    expect(s.activeConversationId).toBeNull();
    expect(s.streaming).toBe(false);
  });

  it('setComposerDraft + clearComposerDraft cycle', () => {
    useChatStore.getState().setComposerDraft('hi');
    expect(useChatStore.getState().composerDraft).toBe('hi');
    useChatStore.getState().clearComposerDraft();
    expect(useChatStore.getState().composerDraft).toBe('');
  });

  it('setStreaming flips flag', () => {
    useChatStore.getState().setStreaming(true);
    expect(useChatStore.getState().streaming).toBe(true);
  });
});
