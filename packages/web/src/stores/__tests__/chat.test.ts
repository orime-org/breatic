// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '@web/stores/chat';

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
