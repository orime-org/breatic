// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一条消息在面板眼里长什么样。
 *
 * 这里只钉一件事：一个工具调用到底走完了没有。SDK 在本地中止一轮时**不会**把
 * 已经发出去的工具调用推到任何终态 —— 它就停在 `input-available`，跟一个正在
 * 跑的工具一模一样。服务端在落库之前专门把这种归一成 error（`main-agent.ts` 那
 * 段「一条已经存下来的记录里不许有任何东西还说自己在跑」），而实时那一侧此前
 * 没有对应的动作：按下停止之后那张卡片会一直转圈，直到刷新页面从库里读回来。
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';

/**
 * 一条带着一个工具调用的回复。
 * @param state - 那个工具停在哪个状态。
 * @returns 这条消息。
 */
function replyWithTool(state: string): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-web_fetch',
        toolCallId: 'call-1',
        state,
        input: { url: 'https://example.com' },
      },
    ],
  } as unknown as UIMessage;
}

describe('一个工具调用走到哪了', () => {
  it('这一轮还在跑，工具没答复就是还在跑', () => {
    const view = toChatMessage(replyWithTool('input-available'), { streaming: true });

    expect(view.toolCalls?.[0]?.status).toBe('pending');
  });

  it('这一轮已经不跑了，工具却没答复，那它就是没跑完', () => {
    // 用户按了停止，或者心跳判死。SDK 不回收已经发出的调用，所以这里读到的
    // 还是 `input-available` —— 但没有任何东西会再让它变了。
    const view = toChatMessage(replyWithTool('input-available'), { streaming: false });

    expect(view.toolCalls?.[0]?.status).toBe('error');
  });

  it('答复回来了就是成功，跟这一轮跑没跑完无关', () => {
    const done = {
      ...replyWithTool('output-available'),
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-1',
          state: 'output-available',
          input: {},
          output: '拿到了',
        },
      ],
    } as unknown as UIMessage;

    expect(toChatMessage(done, { streaming: false }).toolCalls?.[0]?.status).toBe('success');
  });
});
