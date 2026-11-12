// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { breaticPlugin } from "#rules/index";

/**
 * Where `breatic/space-doc-write-gateway` runs, with what exception table,
 * and whether each exception still covers a write (inner#1790 v2 lint spec
 * C-01 to C-04, C-07). Asked of ESLint itself against the real
 * `packages/web/eslint.config.mts`: reading the config text would miss a glob
 * that never matches or a block that turns the rule back off.
 */
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/web");

const RULE = "breatic/space-doc-write-gateway";

/** One exception entry as the calculated config holds it. */
interface Exception {
  file: string;
  function: string;
  reason: string;
}

/**
 * The exceptions added while merging main, which the branch classifies per
 * design section 5.2 and removes before it merges (design section 6).
 */
const TEMPORARY: ReadonlyArray<readonly [string, string]> = [
  ["src/data/yjs/timeline-document.ts", "removeTimelineClip"],
  ["src/data/yjs/timeline-document.ts", "applyTimelineEdit"],
  ["src/data/yjs/timeline-edit-session.ts", "repairAfterPop"],
  ["src/data/yjs/timeline-edit-session.ts", "createTimelineEditSession"],
  ["src/spaces/document/document-upload-controller.ts", "createUploadController"],
  ["src/spaces/timeline/TimelineSpace.tsx", "TimelineEditor"],
];

/**
 * The five exceptions the table had before the merge, plus the undo/redo copy
 * trial v2 adds (design section 5.2), and the dialogue lines writer that sits
 * beside `writeProposalPrompt` in the same placeProposalAt batch (inner#1825);
 * the final table is a subset.
 */
const LONG_TERM: ReadonlyArray<readonly [string, string]> = [
  ["src/data/yjs/canvas-space.ts", "writeSnapshotNodes"],
  ["src/data/yjs/canvas-space.ts", "landHandlingContent"],
  ["src/spaces/canvas/generate/proposal-prompt.ts", "writeProposalPrompt"],
  ["src/spaces/canvas/generate/proposal-prompt.ts", "writeDialogueLines"],
  ["src/data/yjs/scene-document.ts", "applySceneCommand"],
  ["src/data/yjs/scene-session.ts", "historyStep"],
  ["src/data/yjs/history-step.ts", "copyRedone"],
  ["src/data/yjs/history-step.ts", "trial"],
];

/**
 * A stable key for one entry.
 * @param file The entry's file.
 * @param fn The entry's function.
 * @returns `file#function`.
 */
function keyOf(file: string, fn: string): string {
  return `${file}#${fn}`;
}

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

const eslint = new ESLint({ cwd: WEB_ROOT });

/**
 * The calculated rule entry for one web path (paths need not exist).
 * @param file A path relative to packages/web.
 * @returns The rule's entry, or undefined when the rule does not apply.
 */
async function entryFor(file: string): Promise<unknown> {
  const config = (await eslint.calculateConfigForFile(file)) as { rules?: Record<string, unknown> } | undefined;
  return config?.rules?.[RULE];
}

/**
 * The exception table web lints `canvas-space.ts` with.
 * @returns Its entries.
 */
async function webExceptions(): Promise<Exception[]> {
  const entry = await entryFor("src/data/yjs/canvas-space.ts");
  const options = Array.isArray(entry) ? (entry[1] as { exceptions?: Exception[] } | undefined) : undefined;
  return options?.exceptions ?? [];
}

/**
 * Lints web files with only this rule, optionally with another exception table.
 * @param files Paths relative to packages/web.
 * @param exceptions The table to lint with instead of the config's.
 * @returns The rule's reports, as `file:line:column`.
 */
async function reportsIn(files: string[], exceptions?: Exception[]): Promise<string[]> {
  const linter = new ESLint({
    cwd: WEB_ROOT,
    ruleFilter: ({ ruleId }) => ruleId === RULE,
    ...(exceptions === undefined
      ? {}
      : { overrideConfig: { files: ["src/**/*.{ts,tsx}"], rules: { [RULE]: ["error", { exceptions }] } } }),
  });
  const results = await linter.lintFiles(files);
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === RULE)
      .map((message) => `${result.filePath.slice(WEB_ROOT.length + 1)}:${String(message.line)}:${String(message.column)}`),
  );
}

// Read once at collection time, so C-04 gets one named case per entry.
const TABLE = await webExceptions();

describe("C-07 space-doc-write-gateway registration", () => {
  it("C-07 is exported by the plugin under its file name, with a description", () => {
    // registry.test.ts holds disk and plugin equal; this pins that the rule
    // is one of them at all.
    expect(Object.keys(breaticPlugin.rules)).toContain("space-doc-write-gateway");
    const rule = (breaticPlugin.rules as Record<string, { meta?: { docs?: { description?: string } } }>)["space-doc-write-gateway"];
    expect(rule?.meta?.docs?.description?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

describe("C-01 space-doc-write-gateway scope in the web config", () => {
  it.each([
    "src/data/yjs/canvas-space.ts",
    "src/spaces/timeline/TimelineSpace.tsx",
    "src/spaces/document/document-upload-controller.ts",
  ])("C-01 is an error in %s", async (file) => {
    expect(severityOf(await entryFor(file))).toBe(2);
  }, 60_000);

  it.each([
    "src/data/yjs/__tests__/x.test.ts",
    "src/spaces/canvas/x.test.tsx",
    "src/x.spec.ts",
    "tests/smoke/space-size-cap.spec.ts",
  ])("C-01 is absent or off in %s", async (file) => {
    expect(severityOf(await entryFor(file))).toBe(0);
  }, 60_000);
});

describe("C-02 the final exception table in the web config", () => {
  it("C-02 holds none of the temporary merge exceptions", async () => {
    const exceptions = await webExceptions();
    const left = exceptions
      .filter((exception) => TEMPORARY.some(([file, fn]) => keyOf(file, fn) === keyOf(exception.file, exception.function)))
      .map((exception) => keyOf(exception.file, exception.function));
    expect(left, "temporary merge exceptions still in packages/web/eslint.config.mts").toEqual([]);
    const temporaryReasons = exceptions
      .filter((exception) => /^\s*Temporary/i.test(exception.reason))
      .map((exception) => keyOf(exception.file, exception.function));
    expect(temporaryReasons, "entries whose reason still starts with Temporary").toEqual([]);
  }, 60_000);

  it("C-02 is a subset of the long-term exceptions, each with a reason", async () => {
    const exceptions = await webExceptions();
    const allowed = new Set(LONG_TERM.map(([file, fn]) => keyOf(file, fn)));
    const extra = exceptions
      .map((exception) => keyOf(exception.file, exception.function))
      .filter((key) => !allowed.has(key));
    expect(extra, "entries outside the long-term exceptions").toEqual([]);
    const keys = exceptions.map((exception) => keyOf(exception.file, exception.function));
    expect(new Set(keys).size, "an entry is listed twice").toBe(keys.length);
    for (const exception of exceptions) {
      expect(exception.reason.trim().length, exception.function).toBeGreaterThan(0);
    }
  }, 60_000);

  it("C-02 (Q-02) a kept reason that names a refusal names the v2 refusals", async () => {
    // v2 refuses with full, over_ceiling or resyncing; a reason that still
    // says only "returns full" describes the v1 behaviour.
    const stale = (await webExceptions())
      .filter((exception) => /\bfull\b/.test(exception.reason))
      .filter((exception) => !/over_ceiling/.test(exception.reason) || !/resyncing/.test(exception.reason))
      .map((exception) => `${keyOf(exception.file, exception.function)}: ${exception.reason}`);
    expect(stale).toEqual([]);
  }, 60_000);
});

describe("C-03 web source has no write outside the gateway", () => {
  it("C-03 linting packages/web/src gives the rule no report", async () => {
    expect(await reportsIn(["src"])).toEqual([]);
  }, 300_000);
});

describe("C-04 every exception still covers a write", () => {
  // One case per entry of the table as it stands, so a dead entry or a
  // temporary one is named in the failure.
  it("C-04 the web config lists at least one exception to check", () => {
    expect(TABLE.length).toBeGreaterThan(0);
  });

  it.each(TABLE.map((exception) => [keyOf(exception.file, exception.function), exception] as const))(
    "C-04 %s is a final entry and, removed, lets its file report a write",
    async (_key, exception) => {
      expect(
        LONG_TERM.some(([file, fn]) => keyOf(file, fn) === keyOf(exception.file, exception.function)),
        "a temporary merge exception is still in the table (design section 6 removes it)",
      ).toBe(true);
      const rest = TABLE.filter((other) => other !== exception);
      const reports = await reportsIn([exception.file], rest);
      expect(reports.length, `removing ${exception.function} gives no report: a dead entry, delete it`).toBeGreaterThan(0);
    },
    120_000,
  );
});
