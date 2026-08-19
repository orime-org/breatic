// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 读回来的消息说的是协议的话，跟流上的一样。
 *
 * 前端的 `Chat` 实例拿这三个端点的结果当初始 messages，所以它们必须跟流上
 * 的形状一致——一条会话里，读回来的历史和刚流下来的新消息躺在同一个数组里，
 * 形状不同就是同一个列表里两种东西。
 *
 * 库里存的仍是我们自己的 `MessagePart[]`（定稿 §6.4，user 2026-08-19 拍定：
 * 落库格式不跟 AI SDK 走），转换发生在交给浏览器之前。
 *
 * 设计见 inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * §6.4.1。
 */

import { describe, it, expect, vi } from "vitest";
import type { MessageData } from "@breatic/shared";

/**
 * 一条用过工具的会话，三个端点共用。
 *
 * 用 `vi.hoisted` 提上去：下面那个模块替身的工厂会被提到文件顶部执行，
 * 普通的顶层常量那时还没求值。
 */
const STORED = vi.hoisted<MessageData[]>(() => [
  {
    id: "row-1",
    role: "user",
    parts: [{ type: "text", text: "找几张参考图" }],
    content: "找几张参考图",
    ts: "2026-08-19T00:00:00Z",
    turnIndex: 1,
  },
  {
    id: "row-2",
    role: "assistant",
    parts: [
      {
        type: "tool",
        toolCallId: "tc-1",
        toolName: "web_search",
        input: { query: "赛博朋克" },
        status: "success",
        output: "三条链接",
      },
      { type: "text", text: "找到了" },
    ],
    content: "找到了",
    ts: "2026-08-19T00:00:01Z",
    turnIndex: 1,
  },
]);

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  const base = await serverModulesMock(importOriginal);
  return {
    ...base,
    conversationService: {
      ...base.conversationService,
      openChat: vi.fn().mockResolvedValue({
        conversations: [],
        hasMoreConversations: false,
        current: {
          conversation: { id: "conv-1", title: "一条会话" },
          messages: STORED,
          hasMore: false,
        },
      }),
      getWithMessages: vi.fn().mockResolvedValue({
        conversation: { id: "conv-1", title: "一条会话" },
        messages: STORED,
      }),
      getEarlierMessages: vi.fn().mockResolvedValue({
        messages: STORED,
        hasMore: true,
      }),
    },
  };
});

import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

/** 一条消息，如它到达浏览器时的样子。 */
type Wire = {
  id: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  content?: string;
};

/**
 * 读一个端点，把它交出来的那批消息取出来。
 * @param path - 端点地址。
 * @param body - POST 的请求体，GET 时不给。
 * @returns 那批消息。
 */
async function messagesFrom(path: string, body?: Record<string, unknown>): Promise<Wire[]> {
  const app = createApp();
  const res = await app.request(
    path,
    body === undefined
      ? { headers: AUTH }
      : { method: "POST", headers: AUTH, body: JSON.stringify(body) },
  );
  expect(res.status).toBe(200);
  // `/chat/open` answers with more than one conversation's worth, so its
  // messages sit under the one it opened; the other two answer with a page.
  const payload = (await res.json()) as {
    data: { messages?: Wire[]; current?: { messages: Wire[] } };
  };
  return payload.data.current?.messages ?? payload.data.messages ?? [];
}

const ENTRANCES = [
  {
    name: "POST /chat/open",
    read: () => messagesFrom("/api/v1/chat/open", { project_id: PROJECT_ID }),
  },
  {
    name: "GET /chat/conversations/:id",
    read: () => messagesFrom(`/api/v1/chat/conversations/${CONVERSATION_ID}`),
  },
  {
    name: "GET /chat/conversations/:id/messages",
    read: () =>
      messagesFrom(`/api/v1/chat/conversations/${CONVERSATION_ID}/messages?before_turn=5`),
  },
];

describe("读回来的历史跟流上的形状一致", () => {
  for (const entrance of ENTRANCES) {
    it(`${entrance.name} 交出来的是协议的 part`, async () => {
      const messages = await entrance.read();

      // 工具那一条：类型里带工具名，状态跟着 SDK 的说法。库里存的是
      // `{ type: "tool", toolName }`，那是我们自己的形状，`Chat` 认不出来。
      const reply = messages[1];
      expect(reply?.parts).toEqual([
        {
          type: "tool-web_search",
          toolCallId: "tc-1",
          input: { query: "赛博朋克" },
          state: "output-available",
          output: "三条链接",
        },
        { type: "text", text: "找到了" },
      ]);
    });

    it(`${entrance.name} 带上轮次，翻页要靠它`, async () => {
      const messages = await entrance.read();
      expect(messages[0]?.metadata).toEqual({ turnIndex: 1, ts: "2026-08-19T00:00:00Z" });
    });

    it(`${entrance.name} 不再送那两份摊平的副本`, async () => {
      const messages = await entrance.read();
      expect(messages[0]).not.toHaveProperty("content");
    });
  }
});
