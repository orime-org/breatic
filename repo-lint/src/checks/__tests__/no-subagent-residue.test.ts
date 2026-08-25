// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import {
  DELETED_NAMES,
  noSubagentResidue,
} from "#repo-lint/checks/no-subagent-residue";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

// Assembled for the same reason the check assembles them: a fixture that
// spelled one out would make this file a violation of the check it tests.
const DISPATCH_TOOL = ["spawn", "Tool"].join("");
const SCRIPT_TOOL = ["run", "script"].join("_");
const DELETED_SKILL = ["skill", "creator"].join("_");

describe("no-subagent-residue", () => {
  it("passes a repo that names none of them", () => {
    const context = fakeContext({
      "README.md": "The agent runs a workflow, which calls skills.\n",
      "packages/server/src/index.ts": "export const x = 1;\n",
    });
    expect(noSubagentResidue.run(context)).toEqual([]);
  });

  it("catches the dispatch tool, a deleted tool and a deleted skill", () => {
    const context = fakeContext({
      "a.ts": `import { ${DISPATCH_TOOL} } from "x";`,
      "b.json": `{"tools": ["${SCRIPT_TOOL}"]}`,
      "c.md": `The ${DELETED_SKILL} skill lets users author skills.`,
    });
    expect(noSubagentResidue.run(context)).toHaveLength(3);
  });

  // Reading the list rather than a sample of it, so a name added to the check
  // arrives with this exercising it rather than with three of its
  // predecessors standing in.
  it.each(DELETED_NAMES)("catches %s — %s", (name) => {
    const context = fakeContext({ "a.ts": `const x = "${name}";` });
    const findings = noSubagentResidue.run(context);
    // Not exactly one: some names contain another, so planting the longer one
    // legitimately reports both. What has to hold is that the planted name is
    // among what came back.
    expect(findings.some((f) => f.message.includes(`'${name}'`))).toBe(true);
  });

  // The scope is subtraction from the whole tree, not a list of extensions.
  // The residues this check was written for sit in a Dockerfile with no
  // extension and in markdown, so a scan that only reads source files would
  // go green while both still named the deleted things.
  it("reads files with no extension and non-source files", () => {
    const context = fakeContext({
      Dockerfile: `COPY agents/ ./agents/\nRUN echo "${DISPATCH_TOOL}"\n`,
      "docs/ARCHITECTURE.md": `Tools: ${SCRIPT_TOOL}\n`,
    });
    const files = noSubagentResidue.run(context).map((f) => f.file);
    expect(files).toContain("Dockerfile");
    expect(files).toContain("docs/ARCHITECTURE.md");
  });

  it("reports the line the name is on", () => {
    const context = fakeContext({
      "a.ts": `const ok = 1;\nconst bad = "${DISPATCH_TOOL}";\n`,
    });
    expect(noSubagentResidue.run(context)[0]?.line).toBe(2);
  });

  // Both of these are living code the check must not touch. They were the two
  // candidate names rejected during design, and the reasons are only visible
  // by measurement: `getAgentConfig` is the config reader, and bare `spawn`
  // is how worker starts ffmpeg. Guarding them here means a future edit that
  // shortens a name to `getAgent` or `spawn` fails this instead of silently
  // flooding the repo with false reports.
  it("leaves getAgentConfig and ffmpeg's spawn alone", () => {
    const context = fakeContext({
      "a.ts": `import { getAgentConfig } from "@breatic/core";`,
      "b.ts": `import { spawn } from "node:child_process";\nspawn("ffmpeg", args);\n`,
    });
    expect(noSubagentResidue.run(context)).toEqual([]);
  });
});
