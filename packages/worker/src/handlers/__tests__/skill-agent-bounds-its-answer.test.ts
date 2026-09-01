// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A skill job's model calls carry the same output ceiling chat's do (#148, G3).
 *
 * The ceiling is per model call, and the key is named for that rather than for
 * where it is used. Compaction and consolidation have no counterpart on this
 * path — a skill job has no history, no memory and no watermark — but a model
 * call is a model call, and `stopWhen: stepCountIs(skill_agent_max_steps)`
 * lets one job make fifteen of them.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return actual;
});

describe("the model calls a skill job makes", () => {
  it("are bounded by the same key chat's are", () => {
    // Read as text: reaching `runSkillAgent` through the dispatcher would
    // stand up a queue, a database and a provider for one argument.
    const source = readFileSync(
      fileURLToPath(new URL("../dispatch.ts", import.meta.url)),
      "utf8",
    );
    const call = source.slice(
      source.indexOf("const result = await generateTextRetry({"),
      source.indexOf("return [result.text"),
    );

    expect(call).toContain("maxOutputTokens");
    expect(call).toContain("max_output_tokens");
  });
});
