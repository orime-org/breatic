// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '@web/stores/chat';

describe('useChatStore', () => {
  beforeEach(() => {
    useChatStore.setState({
      composerDraft: '',
      activeConversationId: null,
    });
  });

  it('initial state is empty draft and no conversation', () => {
    const s = useChatStore.getState();
    expect(s.composerDraft).toBe('');
    expect(s.activeConversationId).toBeNull();
  });

  it('setComposerDraft + clearComposerDraft cycle', () => {
    useChatStore.getState().setComposerDraft('hi');
    expect(useChatStore.getState().composerDraft).toBe('hi');
    useChatStore.getState().clearComposerDraft();
    expect(useChatStore.getState().composerDraft).toBe('');
  });
});
