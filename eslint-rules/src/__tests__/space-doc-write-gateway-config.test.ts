// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";
import { breaticPlugin } from "#rules/index";

/**
 * Where `breatic/space-doc-write-gateway` runs and with what exception table
 * (inner#1790 lint spec L-43, L-45, L-81). Asked of ESLint itself through
 * `calculateConfigForFile` against the real `packages/web/eslint.config.mts`:
 * reading the config text would miss a glob that never matches or a block
 * that turns the rule back off.
 */
const WEB_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/web",
);

const RULE = "breatic/space-doc-write-gateway";

/**
 * Normalises a rule entry's severity; ESLint returns numbers or words, bare or
 * wrapped in an array when the rule has options.
 * @param entry The rule's value in a calculated config.
 * @returns 0, 1 or 2; 0 when the rule is absent.
 */
function severityOf(entry: unknown): number {
  const value = Array.isArray(entry) ? entry[0] : entry;
  if (value === undefined || value === 0 || value === "off") return 0;
  if (value === 1 || value === "warn") return 1;
  return 2;
}

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: WEB_ROOT });
});

/**
 * The calculated rule entry for one web path (paths need not exist).
 * @param file A path relative to packages/web.
 * @returns The rule's entry, or undefined when the rule does not apply.
 */
async function entryFor(file: string): Promise<unknown> {
  const config = (await eslint.calculateConfigForFile(file)) as
    | { rules?: Record<string, unknown> }
    | undefined;
  return config?.rules?.[RULE];
}

describe("space-doc-write-gateway registration (L-43)", () => {
  it("is exported by the plugin under its file name", () => {
    // registry.test.ts holds disk and plugin equal; this pins that the rule
    // is one of them at all.
    expect(Object.keys(breaticPlugin.rules)).toContain("space-doc-write-gateway");
  });
});

describe("space-doc-write-gateway scope in the web config (L-45)", () => {
  it.each([
    "src/data/yjs/canvas-space.ts",
    "src/spaces/timeline/TimelineSpace.tsx",
    "src/data/yjs/node-storyboard.ts",
  ])("is an error in %s", async (file) => {
    expect(severityOf(await entryFor(file))).toBe(2);
  }, 60_000);

  it.each([
    "src/data/yjs/__tests__/x.test.ts",
    "src/spaces/canvas/x.test.tsx",
    "src/x.spec.ts",
    "tests/smoke/x.spec.ts",
  ])("is absent or off in %s", async (file) => {
    expect(severityOf(await entryFor(file))).toBe(0);
  }, 60_000);
});

describe("space-doc-write-gateway exception table in the web config (L-81)", () => {
  it("is exactly the five excepted functions, each with a reason", async () => {
    const entry = await entryFor("src/data/yjs/canvas-space.ts");
    expect(Array.isArray(entry)).toBe(true);
    const options = (entry as unknown[])[1] as {
      exceptions?: Array<{ file?: unknown; function?: unknown; reason?: unknown }>;
    };
    const exceptions = options?.exceptions ?? [];

    expect(
      exceptions.map((exception) => [exception.file, exception.function]).sort(),
    ).toEqual(
      [
        ["src/data/yjs/canvas-space.ts", "writeSnapshotNodes"],
        ["src/data/yjs/canvas-space.ts", "landHandlingContent"],
        ["src/spaces/canvas/generate/proposal-prompt.ts", "writeProposalPrompt"],
        ["src/data/yjs/scene-document.ts", "applySceneCommand"],
        ["src/data/yjs/scene-session.ts", "historyStep"],
      ].sort(),
    );
    for (const exception of exceptions) {
      expect(typeof exception.reason, String(exception.function)).toBe("string");
      expect(
        (exception.reason as string).trim().length,
        String(exception.function),
      ).toBeGreaterThan(0);
    }
  }, 60_000);
});
