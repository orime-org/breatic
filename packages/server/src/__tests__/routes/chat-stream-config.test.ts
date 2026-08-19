// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 心跳间隔怎么到浏览器手里。
 *
 * 判死一条流靠的是「该来的心跳没来」，而那个「该」是服务端的节奏。两边各写
 * 一个数字，运维调了服务端那个就会让浏览器要么误判健康的流已死、要么等得比
 * 它以为的久 —— 所以间隔只有一个出处（`config/agent.yaml`），浏览器问服务端
 * 要。形状照 `GET /assets/upload-config` 那个已有的旋钮端点。
 *
 * 「连续几次没收到算死」不在这上面，故意的：服务端 GC 期间健康的流也会连丢
 * 两次，把它做成可调的等于给运维一个能把正常轮次杀掉的旋钮。
 *
 * 设计见 inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * §8.5。验收 A9。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  return {
    ...base,
    getAgentConfig: vi.fn().mockReturnValue({
      ...(base.getAgentConfig as () => Record<string, unknown>)(),
      sse_heartbeat_interval_ms: 7000,
    }),
  };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token" };

/**
 * Ask the endpoint what the browser should expect.
 * @returns Its payload.
 */
async function askForStreamConfig(): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  const answer = await createApp().request("/api/v1/chat/stream-config", { headers: AUTH });
  const body = (await answer.json()) as { data: Record<string, unknown> };
  return { status: answer.status, data: body.data };
}

describe("GET /chat/stream-config", () => {
  it("答的是配置里的那个间隔，不是代码里写死的一个", async () => {
    const { status, data } = await askForStreamConfig();

    expect(status).toBe(200);
    expect(data.heartbeatIntervalMs).toBe(7000);
  });

  it("不把「几次算死」交出去", async () => {
    const { data } = await askForStreamConfig();

    expect(Object.keys(data)).toEqual(["heartbeatIntervalMs"]);
  });
});
