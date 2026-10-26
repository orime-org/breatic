// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// After an update reload, the box shows the sentence the user had typed,
// reference blocks included: the draft and the tray come back from two
// stores, and a block survives only when both did.

import { describe, expect, it, vi } from 'vitest';

// Written before any store loads: both read what an update reload carried
// once, when they are created.
await vi.hoisted(async () => {
  const { attachmentMarker } = await import('@breatic/shared');
  sessionStorage.setItem('breatic.reloadDrafts', JSON.stringify({
    conversations: { drafts: { 'c-1': `look ${attachmentMarker('a1')} here` }, current: {} },
    attachments: {
      'c-1': [{
        id: 'a1',
        name: 'cover.png',
        type: 'image',
        status: 'ready',
        chip: { id: 'a1', type: 'image', name: 'cover.png', data_snapshot: { url: 'u' } },
      }],
    },
  }));
});
vi.mock('@web/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { render, screen } from '@testing-library/react';
import { attachmentMarker } from '@breatic/shared';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { chatAttachments } from '@web/stores/chat-attachments';
import { conversationRuntime } from '@web/stores/conversation-runtime';

describe('the chat box after an update reload', () => {
  it('shows the carried sentence with its reference block', () => {
    const draft = conversationRuntime.draftOf('c-1');
    expect(draft).toBe(`look ${attachmentMarker('a1')} here`);
    render(
      <ChatComposer
        conversationId='c-1'
        draft={draft}
        attachments={chatAttachments.trayOf('c-1')}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onAbort={vi.fn()}
      />,
    );
    expect(screen.getByTestId('chat-reference')).toHaveTextContent('cover.png');
    expect(screen.getByTestId('chat-composer-box')).toHaveTextContent('look');
  });
});
