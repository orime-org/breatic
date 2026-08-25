// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 两个字段之间的配对，以及读回来时对它的校验。
 *
 * `kind` 说这次是什么结局，`readerKey` 说界面上写哪句话——两者不是各自独立
 * 的：停止的那句话只属于停止，失败的那几句话只属于失败。配错了不会有任何东西
 * 报错，界面上就是一句对不上的话。
 */
import { describe, it, expect } from "vitest";
import { FAILURE_LINES, toolFailureOf } from "@shared/agent/tool-failure.js";

/**
 * 把一份失败详情挂到一个错误上，绕开构造函数直接摆出想测的组合。
 * @param failure - 要挂上去的东西，形状随意。
 * @returns 挂好的错误。
 */
function errorCarrying(failure: unknown): Error {
  const err = new Error("boom");
  Object.defineProperty(err, "toolFailure", { value: failure, enumerable: false });
  return err;
}

describe("读回一份失败详情", () => {
  it("认得两种正确配对", () => {
    expect(
      toolFailureOf(
        errorCarrying({
          kind: "tool_failed",
          forModel: "the site answered 503",
          readerKey: FAILURE_LINES.upstream,
        }),
      ),
    ).toStrictEqual({
      kind: "tool_failed",
      forModel: "the site answered 503",
      readerKey: FAILURE_LINES.upstream,
    });

    expect(
      toolFailureOf(
        errorCarrying({
          kind: "user_aborted",
          forModel: "the user stopped this turn",
          readerKey: FAILURE_LINES.stopped,
        }),
      ),
    ).toStrictEqual({
      kind: "user_aborted",
      forModel: "the user stopped this turn",
      readerKey: FAILURE_LINES.stopped,
    });
  });

  it("不认「用户停止」配了一句讲失败的话", () => {
    // 界面上会写失败那一句（chat.tool.failure.* 里的任意一条），而实际是用户
    // 自己按的停止——两句话对读的人是相反的意思。这里写键不写文案：文案会改，
    // 键不会。
    expect(
      toolFailureOf(
        errorCarrying({
          kind: "user_aborted",
          forModel: "the user stopped this turn",
          readerKey: FAILURE_LINES.generic,
        }),
      ),
    ).toBeUndefined();
  });

  it("不认「工具失败」配了那句讲停止的话", () => {
    expect(
      toolFailureOf(
        errorCarrying({
          kind: "tool_failed",
          forModel: "the site answered 503",
          readerKey: FAILURE_LINES.stopped,
        }),
      ),
    ).toBeUndefined();
  });

  it("不认表以外的键", () => {
    expect(
      toolFailureOf(
        errorCarrying({
          kind: "tool_failed",
          forModel: "the site answered 503",
          readerKey: "chat.tool.failure.whatever",
        }),
      ),
    ).toBeUndefined();
  });
});
