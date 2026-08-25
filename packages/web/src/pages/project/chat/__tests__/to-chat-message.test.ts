// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

  it('工具自己报了错，跟这一轮跑没跑完无关', () => {
    // 这一支跟「没跑完」是两回事：工具跑了、答复回来了、内容是一个失败。卡片
    // 上要显示它自己的错，不是「被这一轮的结束扫掉的」。
    const failed = {
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-1',
          state: 'output-error',
          input: {},
          errorText: 'chat.tool.failure.unreachable',
          failureKind: 'tool_failed',
        },
      ],
    } as unknown as UIMessage;

    for (const streaming of [true, false]) {
      const view = toChatMessage(failed, { streaming });
      expect(view.toolCalls?.[0]?.status).toBe('error');
      // 带过来的是要翻译的键，不是原因本身——原因只给模型。
      expect(view.toolCalls?.[0]?.failureKey).toBe('chat.tool.failure.unreachable');
      expect(view.toolCalls?.[0]?.failureKind).toBe('tool_failed');
    }
  });

  it('流式期间那句 SDK 的默认错误，不当成我们的文案键', () => {
    // 真机上逮到的：一轮正在跑的时候，前端的 part 是 SDK 客户端自己拼的，
    // errorText 是它写死的一句英文（"An error occurred."）。当时我照单收下，
    // 界面上就直接显示了那句英文——不过 i18n，而产品出五种语言。
    // 判据是这句话本身：`isReaderLine` 拿它去对那张行文案表，对不上就不是
    // 我们给的，跟这一格带不带 failureKind 无关。
    const streaming = {
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-1',
          state: 'output-error',
          input: {},
          errorText: 'An error occurred.',
        },
      ],
    } as unknown as UIMessage;

    const view = toChatMessage(streaming, { streaming: true });

    expect(view.toolCalls?.[0]?.status).toBe('error');
    expect(view.toolCalls?.[0]?.failureKey).toBeUndefined();
    expect(view.toolCalls?.[0]?.failureKind).toBeUndefined();
  });

  it('这一轮被用户停掉时，还在跑的调用算「用户停止」不算失败', () => {
    // 停止之后 part 停在 input-available，SDK 客户端不会把它推到任何终态。
    // 这条消息带着 data-interrupted，那就是「谁停的」这个问题的答案。
    const stopped = {
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-1',
          state: 'input-available',
          input: {},
        },
        { type: 'data-interrupted', data: {} },
      ],
    } as unknown as UIMessage;

    const view = toChatMessage(stopped, { streaming: false });

    expect(view.toolCalls?.[0]?.status).toBe('error');
    expect(view.toolCalls?.[0]?.failureKind).toBe('user_aborted');
  });

  it('用户拒了这次调用，同样是终态', () => {
    const denied = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-web_fetch', toolCallId: 'call-1', state: 'output-denied', input: {} },
      ],
    } as unknown as UIMessage;

    expect(toChatMessage(denied, { streaming: true }).toolCalls?.[0]?.status).toBe('error');
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

describe('直播中的失败文案', () => {
  it('流上带的是我们那张表里的键时就用它', () => {
    // 直播的 part 上没有 `failureKind` —— 那是回放才有的字段。键本身能自证：
    // 它要么在我们那张表里，要么不是我们发的。
    const message: UIMessage = {
      id: 'm-live',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-live',
          state: 'output-error',
          input: { url: 'https://example.com' },
          errorText: 'chat.tool.failure.upstream',
        },
      ],
    } as unknown as UIMessage;

    const view = toChatMessage(message, { streaming: false });

    expect(view.toolCalls?.[0]?.failureKey).toBe('chat.tool.failure.upstream');
  });

  it('表以外的字符串一概不当文案用', () => {
    // SDK 自己那句写死的英文就是从这个字段来的。
    const message: UIMessage = {
      id: 'm-sdk',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-sdk',
          state: 'output-error',
          input: {},
          errorText: 'An error occurred.',
        },
      ],
    } as unknown as UIMessage;

    const view = toChatMessage(message, { streaming: false });

    expect(view.toolCalls?.[0]?.failureKey).toBeUndefined();
  });
});

describe('工具真失败之后这一轮才被停掉', () => {
  it('已经失败的调用不因为这一轮被停而改判成用户停止', () => {
    // 顺序是：工具自己失败了（部件停在 output-error），模型接着往下走，
    // 用户这时按停止。前端就地给这条回复盖上「被停止」的标记，而那条标记
    // 说的是这一轮，不是这次调用。
    const message: UIMessage = {
      id: 'm-both',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-failed',
          state: 'output-error',
          input: { url: 'https://example.com' },
          errorText: 'chat.tool.failure.upstream',
        },
        { type: 'data-interrupted', data: {} },
      ],
    } as unknown as UIMessage;

    const view = toChatMessage(message, { streaming: false });

    expect(view.toolCalls?.[0]?.failureKind).not.toBe('user_aborted');
    expect(view.toolCalls?.[0]?.failureKey).toBe('chat.tool.failure.upstream');
  });

  it('还没跑完的调用在这一轮被停时算用户停止', () => {
    const message: UIMessage = {
      id: 'm-running',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_fetch',
          toolCallId: 'call-running',
          state: 'input-available',
          input: { url: 'https://example.com' },
        },
        { type: 'data-interrupted', data: {} },
      ],
    } as unknown as UIMessage;

    const view = toChatMessage(message, { streaming: false });

    expect(view.toolCalls?.[0]?.failureKind).toBe('user_aborted');
  });
});
