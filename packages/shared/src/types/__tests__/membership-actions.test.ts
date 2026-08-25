// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 面板画哪几个按钮、服务端接受哪几个动作（#106 §13）—— 同一份判据。
 *
 * 两端各留一份副本已经出过两次问题：一次是欠费重试期照画升级按钮，服务端
 * 一律 409；一次是「又欠费、又预约了取消」的账号看到「恢复」，服务端永远
 * 拒绝，因为它问的是处境叫不叫 cancelling，而面板问的是有没有预约取消 ——
 * 这两个问题对这一格恰好给出相反的答案。
 */

import { describe, it, expect } from "vitest";
import {
  subscriptionActions,
  SUBSCRIPTION_SITUATIONS,
} from "@shared/types/membership.js";

describe("subscriptionActions — 升级入口", () => {
  it("欠费重试时不给：服务端对它一律拒绝", () => {
    expect(subscriptionActions("retrying", false).upgrade).toBe("withheld");
  });

  it("升级已买待付款时显示为处理中，不邀请再买一次", () => {
    expect(subscriptionActions("upgradePending", false).upgrade).toBe(
      "pending",
    );
  });

  it.each(["none", "firstPaymentUnsettled", "active", "cancelling", "unexpected"] as const)(
    "%s 时照常给",
    (state) => {
      expect(subscriptionActions(state, false).upgrade).toBe("offered");
    },
  );
});

describe("subscriptionActions — 取消与恢复", () => {
  it("又欠费又预约了取消：给恢复，不给取消", () => {
    // 这一格是两套判据分叉的地方。处境读出来叫 retrying（欠费优先于预约
    // 取消），而这个账号确实预约了取消，所以能做的是撤销它。
    const actions = subscriptionActions("retrying", true);
    expect(actions.resume).toBe(true);
    expect(actions.cancel).toBe(false);
  });

  it("欠费但没预约取消：给取消", () => {
    const actions = subscriptionActions("retrying", false);
    expect(actions.cancel).toBe(true);
    expect(actions.resume).toBe(false);
  });

  it("正常订阅：给取消", () => {
    expect(subscriptionActions("active", false)).toMatchObject({
      cancel: true,
      resume: false,
    });
  });

  it("已预约取消：给恢复", () => {
    expect(subscriptionActions("cancelling", true)).toMatchObject({
      cancel: false,
      resume: true,
    });
  });

  it.each(["none", "firstPaymentUnsettled", "unexpected"] as const)(
    "%s 时两个都不给：没有可操作的订阅",
    (state) => {
      expect(subscriptionActions(state, false)).toMatchObject({
        cancel: false,
        resume: false,
      });
      expect(subscriptionActions(state, true)).toMatchObject({
        cancel: false,
        resume: false,
      });
    },
  );

  it("每个处境都有答案，一个都不漏", () => {
    for (const state of SUBSCRIPTION_SITUATIONS) {
      for (const scheduled of [true, false]) {
        const actions = subscriptionActions(state, scheduled);
        expect(["offered", "pending", "withheld"]).toContain(actions.upgrade);
        expect(typeof actions.cancel).toBe("boolean");
        expect(typeof actions.resume).toBe("boolean");
      }
    }
  });
});
