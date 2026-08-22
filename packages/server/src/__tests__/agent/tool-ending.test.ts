// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一次调用结束时,轮次替它说的那些话。
 *
 * 工具自己失败时会把理由一起抛出来,而有几种结局工具压根没参与:调用在
 * `execute` 之前就被拒了、轮次在工具启动前结束了、用户按了停止。这几种的
 * 说法写死在代码里,而它们跟工具抛的那些话一样,都会原样进到模型下一轮读的
 * 历史里。
 *
 * 这里钉的是「每条理由都要以下一步收尾」。工具那一侧早有一条测试要求它
 * (`web-fetch-failure.test.ts` 的 “closes every one of its reasons with what
 * the model may do next”),而这一侧的四条一直没人要求 —— 把它们清空,五百多
 * 条测试一条都不红,而空理由正是这次改动要消灭的东西。
 */

import { describe, it, expect } from "vitest";
import { NOTHING_SAID_WHY, carrying } from "@breatic/shared";
import type { ToolFailure } from "@breatic/shared";
import { STOPPED_BY_USER } from "@breatic/domain";

import { endingOf, TURN_ENDED_AROUND_IT } from "@server/agent/tool-ending.js";

/**
 * 一句话有没有告诉模型接下来能做什么。
 *
 * 各条的下一步并不相同 —— 从没跑过的那条值得再调一次,被拒的地址一次都不该
 * 再调 —— 所以这里认的是「说了某种下一步」,不是某一句固定的话。
 */
const SAYS_WHAT_NEXT =
  /call it again|try once more|try it again|do not call|do not retry|correct|tell the user|ask/i;

describe("轮次替一次调用说的每句话,都说了下一步", () => {
  it.each([
    ["TURN_ENDED_AROUND_IT", TURN_ENDED_AROUND_IT],
    ["STOPPED_BY_USER", STOPPED_BY_USER],
    ["NOTHING_SAID_WHY", NOTHING_SAID_WHY],
  ])("%s", (_name: string, failure: ToolFailure) => {
    expect(failure.forModel.trim()).not.toBe("");
    expect(failure.forModel).toMatch(SAYS_WHAT_NEXT);
  });

  it("SDK 拒掉的调用,在它自己那句话后面接上下一步", () => {
    // 这一条的前半截是 SDK 的原话,哪个字段不合 schema 就写在里面 —— 那正是
    // 模型改这次调用所需要的。它自己不说下一步,而这是全部结局里最该重来的
    // 一种:调用根本没发出去,改对参数就成了。
    const ending = endingOf(new Error("AI_InvalidToolInputError: url must be a string"));

    expect(ending.forModel).toContain("url must be a string");
    expect(ending.forModel).toMatch(SAYS_WHAT_NEXT);
  });

  it("工具自己带了理由时,一个字都不改地交回去", () => {
    // 工具知道自己在做什么,它那句话已经带着下一步了。在后面再接一句,等于让
    // 一次失败有两个互相不知道对方存在的指示。
    const own: ToolFailure = {
      kind: "tool_failed",
      forModel: "Fetching https://example.com failed: do not fetch the same address again.",
      readerKey: "chat.tool.failure.upstream",
    };

    expect(endingOf(carrying(new Error("the message"), own))).toStrictEqual(own);
  });
});
