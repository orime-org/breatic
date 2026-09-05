// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The line that says the model thought, and for how long.
 *
 * C3: a line with an arrow, no bar and no frame, and an expanded body that
 * lines up under the label. The duration is measured by the server -- the
 * provider says when each stretch of thinking opens and closes -- and travels
 * as a part of the reply, so it reads the same live and after a reload.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThinkingFold } from '@web/pages/project/chat/ThinkingFold';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
import type { UIMessage } from 'ai';

afterEach(cleanup);

describe('how long it thought', () => {
  it('reads the figure off the reply', () => {
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '想了想' },
        { type: 'data-thinking-time', data: { ms: 6200 } },
      ],
    } as unknown as UIMessage);

    expect(message.thinkingMs).toBe(6200);
  });

  it('says seconds under a minute', () => {
    render(<ThinkingFold thinking='x' ms={6200} />);

    expect(screen.getByTestId('thinking-fold-toggle')).toHaveTextContent('6');
  });

  it('says minutes and seconds past one', () => {
    render(<ThinkingFold thinking='x' ms={95_000} />);

    const label = screen.getByTestId('thinking-fold-toggle').textContent ?? '';
    expect(label).toContain('1');
    expect(label).toContain('35');
  });

  it('never says it thought for no time at all', () => {
    // 服务端只要 >0 就发，而 1–499ms 四舍五入到 0，屏幕上就成了「思考了 0 秒」。
    render(<ThinkingFold thinking='x' ms={120} />);

    expect(screen.getByTestId('thinking-fold-toggle').textContent ?? '').not.toMatch(/\b0\b/);
  });

  it('still names itself when the turn carries no figure', () => {
    render(<ThinkingFold thinking='x' />);

    expect(screen.getByTestId('thinking-fold-toggle').textContent).not.toBe('');
  });
});

describe('the shape C3 asks for', () => {
  it('hugs its own content rather than filling the reply', () => {
    render(<ThinkingFold thinking='x' ms={1000} />);

    const toggle = screen.getByTestId('thinking-fold-toggle');
    expect(toggle.className).not.toMatch(/\bw-full\b/);
    expect(toggle.className).not.toMatch(/hover:bg-/);
  });

  it('lines the expanded body up under the label', async () => {
    render(<ThinkingFold thinking='想了想' ms={1000} />);

    await userEvent.click(screen.getByTestId('thinking-fold-toggle'));

    // 标签左边是箭头加间距，正文要对齐到标签，不是对齐到箭头。
    expect(screen.getByTestId('thinking-fold-body').className).toMatch(/\bpl-/);
  });
});
