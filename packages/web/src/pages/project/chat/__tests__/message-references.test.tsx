// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// A sent message keeps its references: they show as blocks in the bubble, and
// copying the message gives the attachments' names.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { attachmentMarker } from '@breatic/shared';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';

const said: ChatMessage = {
  id: 'm1',
  role: 'user',
  content: `compare ${attachmentMarker('a1')} with ${attachmentMarker('gone')}`,
  attachments: [{ id: 'a1', type: 'image', name: 'cover.png', data_snapshot: { url: 'u' } }],
};

describe('a sent message with references', () => {
  it('shows a reference to one of its attachments as a block with the name', () => {
    render(<MessageBubble message={said} />);

    expect(screen.getByTestId('message-reference')).toHaveTextContent('cover.png');
    expect(screen.getByTestId('message-bubble-content')).not.toHaveTextContent(attachmentMarker('a1'));
  });

  it('leaves a marker for something it did not carry as the text it is', () => {
    render(<MessageBubble message={said} />);

    expect(screen.getAllByTestId('message-reference')).toHaveLength(1);
    expect(screen.getByTestId('message-bubble-content')).toHaveTextContent(attachmentMarker('gone'));
  });

  it('copies with the names in place of the markers', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<MessageBubble message={said} />);

    await userEvent.click(screen.getByTestId('turn-copy'));

    expect(writeText).toHaveBeenCalledWith(`compare cover.png with ${attachmentMarker('gone')}`);
  });

  it('copies an unnamed piece of the canvas the way the bubble names it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const picked: ChatMessage = {
      id: 'm2',
      role: 'user',
      content: `see ${attachmentMarker('c1')}`,
      attachments: [{ id: 'c1', type: 'canvas', name: '', data_snapshot: { nodes: [{}, {}, {}], edges: [] } }],
    };
    render(<MessageBubble message={picked} />);

    await userEvent.click(screen.getByTestId('turn-copy'));

    expect(writeText).toHaveBeenCalledWith(`see ${screen.getByTestId('message-reference').textContent ?? ''}`);
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('canvas, 3 nodes'));
  });
});
