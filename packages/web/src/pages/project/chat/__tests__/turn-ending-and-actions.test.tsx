// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a reply says about how it ended, and what it offers afterwards.
 *
 * The line that says nothing came back has to mean it: a turn whose last act
 * was to show what it found produced something, and it is drawn directly
 * above that line. And the copy on a reader's own message appears on hover --
 * appears, rather than being there all along at zero opacity, which reserves
 * a strip under every message and leaves a control that can be pressed and
 * tabbed to with nothing visible there.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';

afterEach(cleanup);

describe('the line that says nothing came back', () => {
  it('stays away from a turn that found things but said nothing', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          assets: [{ kind: 'image', url: 'https://i.example/1.png', title: 'One' }],
        }}
      />,
    );

    expect(screen.getByTestId('asset-row')).toBeInTheDocument();
    expect(screen.queryByTestId('message-bubble-empty')).toBeNull();
  });

  it('stays away from a turn that found sources but said nothing', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          sources: [
            { url: 'https://a.example', title: 'A', publisher: 'A', index: 1 },
          ],
        }}
      />,
    );

    expect(screen.queryByTestId('message-bubble-empty')).toBeNull();
  });

  it('still says it when the turn produced nothing at all', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '' }} />);

    expect(screen.getByTestId('message-bubble-empty')).toBeInTheDocument();
  });
});

describe('the copy on a reader\'s own message', () => {
  it('takes no room and cannot be pressed until it is hovered', () => {
    render(<MessageBubble message={{ id: 'm', role: 'user', content: '找参考图' }} />);

    const actions = screen.getByTestId('turn-actions');
    expect(actions.className).toMatch(/\babsolute\b/);
    expect(actions.className).toMatch(/pointer-events-none/);
    expect(actions.className).toMatch(/group-hover:pointer-events-auto/);
  });
});
