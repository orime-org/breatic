// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '@web/stores/chat';

describe('useChatStore', () => {
  beforeEach(() => {
    useChatStore.setState({ activeConversationId: null });
  });

  it('starts with no conversation selected', () => {
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });

  it('forgets the selection on reset', () => {
    // The draft used to live here too. It belongs to a conversation, not to a
    // panel, so it moved to `stores/conversation-runtime` -- one per
    // conversation rather than one for the column.
    useChatStore.getState().setActiveConversationId('c-1');
    useChatStore.getState().reset();
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });
});
