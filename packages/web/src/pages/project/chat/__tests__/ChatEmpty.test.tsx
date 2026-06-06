// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { useCurrentUserStore } from '@web/stores';

describe('ChatEmpty', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
  });

  it('renders a generic greeting when no user is signed in', () => {
    render(<ChatEmpty />);
    expect(screen.getByTestId('chat-empty')).toHaveTextContent('Hi!');
  });

  it('personalizes the greeting with the current user name', () => {
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Songxiulei',
      email: 'sx@example.com',
      personalStudio: { name: 'Songxiulei', slug: 'songxiulei' },
    });
    render(<ChatEmpty />);
    expect(screen.getByTestId('chat-empty')).toHaveTextContent(
      'Hi, Songxiulei!',
    );
  });

  it('renders all three quick-action buttons (image / music / pen)', () => {
    render(<ChatEmpty />);
    expect(screen.getByTestId('chat-empty-qa-image')).toBeInTheDocument();
    expect(screen.getByTestId('chat-empty-qa-music')).toBeInTheDocument();
    expect(screen.getByTestId('chat-empty-qa-pen')).toBeInTheDocument();
  });

  it('clicking a quick action fires onQuickAction with the label', async () => {
    const user = userEvent.setup();
    const onQuickAction = vi.fn();
    render(<ChatEmpty onQuickAction={onQuickAction} />);
    await user.click(screen.getByTestId('chat-empty-qa-image'));
    expect(onQuickAction).toHaveBeenCalledWith(
      'Generate a cyberpunk-style image',
    );
  });
});
