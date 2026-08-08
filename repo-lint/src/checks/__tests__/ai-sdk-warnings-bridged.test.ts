// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { aiSdkWarningsBridged } from "#repo-lint/checks/ai-sdk-warnings-bridged";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const BRIDGE = `globalThis.AI_SDK_LOG_WARNINGS = ({ warnings }) => {
  logger.warn({ warnings }, "ai_sdk_warning");
};
`;

/** Both entries, each with whatever body the test wants. */
function entries(server: string, worker: string): Record<string, string> {
  return {
    "packages/server/src/index.ts": server,
    "packages/worker/src/index.ts": worker,
  };
}

describe("ai-sdk-warnings-bridged", () => {
  it("passes when both entries install the bridge", () => {
    expect(aiSdkWarningsBridged.run(fakeContext(entries(BRIDGE, BRIDGE)))).toEqual([]);
  });

  it("reports an entry with no bridge at all", () => {
    const context = fakeContext(entries(BRIDGE, "initLogger('worker');\n"));
    expect(aiSdkWarningsBridged.run(context)).toEqual([
      expect.objectContaining({ file: "packages/worker/src/index.ts" }),
    ]);
  });

  it("reports an entry that switches warnings off instead", () => {
    // One character from a working bridge, and it reads as deliberate in a
    // diff — which is why it is refused by name rather than left to review.
    const context = fakeContext(
      entries(BRIDGE, "globalThis.AI_SDK_LOG_WARNINGS = false;\n"),
    );
    const findings = aiSdkWarningsBridged.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/turns the SDK's warnings off/);
  });

  it("reports an entry that is gone rather than passing on its absence", () => {
    // The reason this is a repo-lint check and not an ESLint rule: a deleted
    // entry is a file nothing lints, so a rule keyed on its contents never
    // runs and the absence reads as clean.
    const context = fakeContext({ "packages/server/src/index.ts": BRIDGE });
    expect(aiSdkWarningsBridged.run(context)).toEqual([
      expect.objectContaining({ file: "packages/worker/src/index.ts" }),
    ]);
  });

  it("checks both entries, not just the first", () => {
    const context = fakeContext(entries("initLogger('server');\n", "x\n"));
    expect(aiSdkWarningsBridged.run(context)).toHaveLength(2);
  });
});
