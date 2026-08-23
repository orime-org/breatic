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

import { endingOf, endingWithNothingRun } from "@server/agent/tool-ending.js";

/**
 * 一句话有没有告诉模型接下来能做什么。
 *
 * 各条的下一步并不相同 —— 从没跑过的那条值得再调一次,被拒的地址一次都不该
 * 再调 —— 所以这里认的是「说了某种下一步」,不是某一句固定的话。
 */
const EACH_SAYS = [
  {
    name: "endingWithNothingRun,轮次失败",
    failure: endingWithNothingRun(false),
    says: /call it again/i,
    notSays: /do not call it again|still running/i,
  },
  {
    name: "endingWithNothingRun,用户停止",
    failure: endingWithNothingRun(true),
    says: /call it again/i,
    // 这次调用连启动都没有 —— 参数还没发完轮次就结束了。说它「还在跑」是把
    // 一件没发生的事写进记录,而配套的「别再自己调」正好指向反面:什么都没
    // 试过,再调一次才是对的。
    notSays: /do not call it again|still running/i,
  },
  {
    name: "STOPPED_BY_USER",
    failure: STOPPED_BY_USER,
    says: /do not call it again/i,
    // 不指认是谁结束的。服务端只有一个信号,它盖住停止按钮、关标签页、断网和
    // 笔记本睡眠;把继续与否挂在「等用户再问一次」上,只有用户真按了停止时才
    // 说得通。掉线那几种里用户什么都没取消,却被要求非等他重新开口不可。
    notSays: /the user asks|user stopped|user pressed/i,
  },
  {
    name: "NOTHING_SAID_WHY",
    failure: NOTHING_SAID_WHY,
    says: /try it once more/i,
    notSays: /do not/i,
  },
] as const;

describe("轮次替一次调用说的每句话,都说了它自己那个下一步", () => {
  // 逐条钉各自该说的内容,不共用一条「说了某种下一步」的正则 —— 那样的正则要
  // 同时认「再调一次」和「别再调」,于是把两条常量的下一步对调也照样全绿(实测
  // 过),一句话和它的反面在它眼里是一样的。而这几条的分歧正好在这里:从没跑过
  // 的那次值得再调,已经结束的那次一次都不该再调。
  it.each(EACH_SAYS)("$name", ({ failure, says, notSays }) => {
    expect(failure.forModel.trim()).not.toBe("");
    expect(failure.forModel).toMatch(says);
    expect(failure.forModel).not.toMatch(notSays);
  });

  it("同一件事,对读的人和对模型分开说", () => {
    // 两个字段答的是两个问题。模型那半两边一样 —— 事实就是这一次什么都没跑;
    // 读的人那半两边必须不一样,按了停止的人不该看到一个失败图标。把这两支
    // 对调,原先五百多条测试一条都不红。
    const stopped = endingWithNothingRun(true);
    const failed = endingWithNothingRun(false);

    expect(stopped.forModel).toBe(failed.forModel);
    expect(stopped.kind).toBe("user_aborted");
    expect(failed.kind).toBe("tool_failed");
    expect(stopped.readerKey).not.toBe(failed.readerKey);
  });

  it("SDK 拒掉的调用,在它自己那句话后面接上下一步", () => {
    // 这一条的前半截是 SDK 的原话,哪个字段不合 schema 就写在里面 —— 那正是
    // 模型改这次调用所需要的。它自己不说下一步,而这是全部结局里最该重来的
    // 一种:调用根本没发出去,改对参数就成了。
    const ending = endingOf(new Error("AI_InvalidToolInputError: url must be a string"));

    expect(ending.forModel).toContain("url must be a string");
    expect(ending.forModel).toMatch(/correct the call and try once more/i);
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
