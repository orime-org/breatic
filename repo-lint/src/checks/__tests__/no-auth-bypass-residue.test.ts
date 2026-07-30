// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import {
  BYPASS_NAMES,
  noAuthBypassResidue,
} from "#repo-lint/checks/no-auth-bypass-residue";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

// Assembled for the same reason the check assembles them: a fixture that
// spelled one out would make this file a violation of the check it tests.
const SWITCH = ["LOGIN", "MODE"].join("_");
const BYPASS_VALUE = ["No", "Account"].join("");
const FRONTEND_SYMBOL = `${["inject", "Dev"].join("")}User`;

describe("no-auth-bypass-residue", () => {
  it("passes a repo with no residue", () => {
    const context = fakeContext({
      "README.md": "Every environment requires a real login.\n",
      "packages/server/src/index.ts": "export const x = 1;\n",
    });
    expect(noAuthBypassResidue.run(context)).toEqual([]);
  });

  it("catches the switch, its values and the frontend symbol", () => {
    const context = fakeContext({
      "a.ts": `const mode = "${SWITCH}";`,
      "b.ts": `if (mode === "${BYPASS_VALUE}") {}`,
      "c.ts": `import { ${FRONTEND_SYMBOL} } from "x";`,
    });
    expect(noAuthBypassResidue.run(context)).toHaveLength(3);
  });

  // Reading the list rather than a sample of it, so a name added to the
  // check arrives with this exercising it rather than with three of its
  // predecessors standing in.
  it.each(BYPASS_NAMES)("catches %s — %s", (name) => {
    const context = fakeContext({ "a.ts": `const x = "${name}";` });
    const findings = noAuthBypassResidue.run(context);
    // Not exactly one: some names contain another, so planting the longer
    // one legitimately reports both. What has to hold is that the planted
    // name is seen at all, and that everything reported names something
    // from the list rather than whatever else was on the line.
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.file).toBe("a.ts");
      expect(
        BYPASS_NAMES.some(([known]) => finding.message.includes(known)),
      ).toBe(true);
    }
  });

  it("scans files with no extension at all", () => {
    // Three of the four residues that motivated this were a README, a
    // Dockerfile with no extension, and an env template. An extension
    // filter would have missed them.
    const context = fakeContext({
      Dockerfile: `ENV ${SWITCH}=x`,
      ".env.dev": `${SWITCH}=x`,
      "README.md": `set ${SWITCH}`,
    });
    expect(noAuthBypassResidue.run(context)).toHaveLength(3);
  });

  it("catches a mention inside a comment", () => {
    // A comment saying the mode used to exist still tells a reader that
    // auth might be optional, and the mode is gone.
    const context = fakeContext({ "a.ts": `// ${SWITCH} was removed in #147` });
    expect(noAuthBypassResidue.run(context)).toHaveLength(1);
  });

  it("names the file and line", () => {
    const context = fakeContext({ "a.ts": `one\ntwo\nconst m = "${SWITCH}";` });
    const findings = noAuthBypassResidue.run(context);
    expect(findings[0]?.file).toBe("a.ts");
    expect(findings[0]?.line).toBe(3);
  });

  it("reports each distinct name on a line separately", () => {
    const context = fakeContext({
      "a.ts": `const m = "${SWITCH}"; const v = "${BYPASS_VALUE}";`,
    });
    expect(noAuthBypassResidue.run(context)).toHaveLength(2);
  });

  it("permits the migration that had to name what it deleted", () => {
    const context = fakeContext({
      "packages/core/src/db/migrations/0016_delete-dev-mock-user.sql": `-- removes the ${BYPASS_VALUE} mock user`,
      "a.ts": "clean",
    });
    expect(noAuthBypassResidue.run(context)).toEqual([]);
  });

  it("skips binaries the way git does", () => {
    const context = fakeContext({
      "logo.png": `\u0000${SWITCH}`,
      "a.ts": "clean",
    });
    expect(noAuthBypassResidue.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", () => {
    const context = fakeContext({
      "packages/core/src/db/migrations/0016_delete-dev-mock-user.sql": "x",
    });
    expect(() => noAuthBypassResidue.run(context)).toThrow(/matched none/);
  });

  it("skips a file whose bytes are not text", () => {
    // It scans every tracked file rather than a list of extensions, which is
    // the point — three of the four original residues lived where an
    // extension list does not reach. That makes reading a binary as text a
    // real possibility, so the shared text decision has to hold here too.
    // The forbidden name is really in the fixture, so this fails if the
    // binary is scanned rather than skipped — a placeholder name would have
    // passed either way and tested nothing.
    const forbidden = BYPASS_NAMES[0]?.[0] ?? "";
    expect(forbidden).not.toBe("");
    const context = fakeContext({
      "docs/notes.md": "nothing here\n",
      "assets/blob.dat": `${forbidden}\u0000\u0000not text`,
    });
    expect(noAuthBypassResidue.run(context)).toEqual([]);

    // And the same name in a text file is still reported, so the skip above
    // is the binary decision rather than the name having stopped matching.
    const readable = fakeContext({ "docs/notes.md": `${forbidden}\n` });
    expect(noAuthBypassResidue.run(readable)).toHaveLength(1);
  });
});
