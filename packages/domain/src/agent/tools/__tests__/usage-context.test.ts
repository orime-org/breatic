// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A paid tool holds its own estimate before it spends (inner#1611): the turn's
 * hold grows by it, and a studio that cannot cover it gets a refusal the model
 * can read instead of a call that is charged into debt.
 */

import { describe, it, expect, vi } from "vitest";

import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import { holdForTool, usageContextFor, type UsageContext } from "@domain/agent/tools/usage-context.js";
import type { UsageRecorder } from "@domain/credit/usage-recorder.js";

const usage = { recordServiceCall: vi.fn(), recordModelCall: vi.fn() } as unknown as UsageRecorder;

describe("holdForTool", () => {
  it("passes when the turn's hold grew by the estimate", async () => {
    const extend = vi.fn(async () => true);
    await holdForTool({ usage, hold: { extend } }, 2);
    expect(extend).toHaveBeenCalledWith(2);
  });

  it("refuses with the credits line when the hold cannot grow", async () => {
    const context: UsageContext = { usage, hold: { extend: async () => false } };
    const err = await holdForTool(context, 2).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(toolFailureOf(err)).toMatchObject({ kind: "tool_failed", readerKey: FAILURE_LINES.credits });
    expect(toolFailureOf(err)?.forModel).toMatch(/credits/i);
  });

  it("passes without asking when the run holds nothing", async () => {
    await expect(holdForTool({ usage }, 2)).resolves.toBeUndefined();
  });
});

describe("usageContextFor", () => {
  it("hands every tool the same recorder and hold", () => {
    const hold = { extend: async () => true };
    expect(usageContextFor({ a: {}, b: {} }, usage, hold)).toEqual({ a: { usage, hold }, b: { usage, hold } });
  });
});
