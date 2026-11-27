// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from "vitest";
import { getMiniToolsConfig, miniToolsConfigSchema } from "../mini-tools.js";

/** Supply test-only capacity overrides, not an unmeasured production capacity claim. @throws {never} Never. */
function configured(): Record<string, unknown> {
  const current = structuredClone(getMiniToolsConfig());
  return { ...current, executions: { ...current.executions,
    // Design §5.4 (S6b) adds max_outputs_per_job, bounded by the job contract; values here are test overrides.
    "video.extract-frames": { container_class: "MiniToolContainerStd4", precheck_seconds: 17, max_outputs: 3, max_outputs_per_job: 2 },
    "video.split": { container_class: "MiniToolContainerStd4", precheck_seconds: 23, max_outputs: 4, max_outputs_per_job: 3 } } };
}

describe("S5 planned container execution configuration", () => {
  it("S5-K01 retains configured estimates and capacities", () => {
    const input = configured();
    const parsed = miniToolsConfigSchema.parse(input);
    expect(parsed.executions).toEqual(input.executions);
    expect(parsed.classes.MiniToolContainerStd4).toMatchObject({ vcpu: 4, memory_gib: 12 });
    expect(parsed.presentation).toEqual(getMiniToolsConfig().presentation);
  });
  it.each(["video.extract-frames", "video.split"])("S5-K01 loads a configured %s default without a test-authored capacity constant", (tool) => {
    const value: unknown = Reflect.get(getMiniToolsConfig().executions, tool);
    expect(value).toMatchObject({ container_class: "MiniToolContainerStd4", precheck_seconds: expect.any(Number), max_outputs: expect.any(Number), max_outputs_per_job: expect.any(Number) });
    expect(miniToolsConfigSchema.parse(getMiniToolsConfig()).executions).toEqual(getMiniToolsConfig().executions);
  });
  it.each([
    ["max_outputs", 0], ["max_outputs", -1], ["max_outputs", 1.5], ["max_outputs", Number.MAX_SAFE_INTEGER + 1],
    ["precheck_seconds", 0], ["precheck_seconds", -1], ["precheck_seconds", Number.NaN], ["container_class", "UndeclaredContainer"],
  ])("S5-K01 rejects %s=%s after accepting the same complete valid configuration", (field, value) => {
    const input = configured();
    expect(miniToolsConfigSchema.parse(input).executions).toEqual(input.executions);
    const executions = input.executions as Record<string, Record<string, unknown>>;
    executions["video.split"]![String(field)] = value;
    expect(miniToolsConfigSchema.safeParse(input).success).toBe(false);
  });
});
