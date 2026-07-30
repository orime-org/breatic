// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { complaintsFrom } from "#repo-lint/doc-complaints";

const ROOT = "/repo";

/** The colour the resolver wraps a severity in, even when piped. */
const YELLOW = "\u001b[93m";
const RESET = "\u001b[39m";

describe("complaintsFrom", () => {
  it("finds nothing in a clean run", () => {
    expect(complaintsFrom(ROOT, "", "packages/core/src/index.ts")).toEqual([]);
  });

  it("sees a warning through the colour codes", () => {
    // The resolver writes these even to a pipe, so without stripping them
    // the severity is not at the start of the line and nothing matches.
    const line = `${YELLOW}[warning]${RESET} Failed to resolve link to "gone".`;
    expect(complaintsFrom(ROOT, line, "entry.ts")).toHaveLength(1);
  });

  it("sees an error as well as a warning", () => {
    const output = "[warning] one\n[error] two\n";
    expect(complaintsFrom(ROOT, output, "entry.ts")).toHaveLength(2);
  });

  it("ignores the resolver's ordinary chatter", () => {
    const output = "[info] Using tsconfig\nDocumentation generated\n";
    expect(complaintsFrom(ROOT, output, "entry.ts")).toEqual([]);
  });

  it("recovers the file and line the complaint names", () => {
    const output =
      '[warning] Failed to resolve link to "x" in /repo/packages/core/src/a.ts:42';
    const [finding] = complaintsFrom(ROOT, output, "entry.ts");
    expect(finding?.file).toBe("packages/core/src/a.ts");
    expect(finding?.line).toBe(42);
  });

  it("falls back to the entry point when no location is named", () => {
    const [finding] = complaintsFrom(ROOT, "[warning] something", "entry.ts");
    expect(finding?.file).toBe("entry.ts");
    expect(finding?.line).toBeUndefined();
  });

  it("keeps the resolver's own words in the message", () => {
    const [finding] = complaintsFrom(
      ROOT,
      '[warning] Failed to resolve link to "missingThing".',
      "entry.ts",
    );
    expect(finding?.message).toContain("missingThing");
  });

  it("does not match a severity marker mid-line", () => {
    // A doc comment may quote one; only a line the resolver itself wrote
    // starts with it.
    const output = "  // see [warning] in the docs\n";
    expect(complaintsFrom(ROOT, output, "entry.ts")).toEqual([]);
  });

  it("handles a .tsx location", () => {
    const output = "[warning] x in /repo/packages/web/src/A.tsx:7";
    expect(complaintsFrom(ROOT, output, "entry.ts")[0]?.file).toBe(
      "packages/web/src/A.tsx",
    );
  });
});
