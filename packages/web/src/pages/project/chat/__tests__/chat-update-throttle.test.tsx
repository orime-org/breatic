// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What paces the panel while a reply streams.
 *
 * Left unset, every SSE chunk notifies React and the whole message is parsed
 * and rebuilt again. Measured in jsdom at 8000 characters one such update
 * costs 18.5ms, so at a few dozen chunks a second the main thread has nothing
 * left; the interval hands that back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const useChatSpy = vi.fn();

vi.mock('@ai-sdk/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-sdk/react')>();
  return {
    ...actual,
    useChat: (options: unknown) => {
      useChatSpy(options);
      return actual.useChat(options as never);
    },
  };
});

describe('chat update pacing', () => {
  beforeEach(() => {
    useChatSpy.mockClear();
    vi.resetModules();
  });

  it('hands useChat a throttle of 50ms', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useChatSession } = await import('@web/pages/project/chat/use-chat-session');

    renderHook(() => useChatSession('p-1', false));

    expect(useChatSpy).toHaveBeenCalled();
    const options = useChatSpy.mock.calls[0]?.[0] as { throttle?: number };
    expect(options.throttle).toBe(50);
  });
});
