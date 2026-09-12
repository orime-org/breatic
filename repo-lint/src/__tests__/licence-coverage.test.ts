// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { licenceCoverage } from "#repo-lint/licence-coverage";

/**
 * A notice shaped like the real one: two sections of what we distribute, then
 * the section that declares what we do not. The split matters to the judge, so
 * every case carries it.
 */
const NOTICE = [
  "# Third-Party Notices",
  "",
  "## Programs in our container images",
  "",
  "### FFmpeg",
  "",
  "| Licence | **GPL-2.0-or-later** |",
  "",
  "## Packages reachable from the front-end bundle",
  "",
  "### BlockNote",
  "",
  "| Packages | `@blocknote/core`, `@blocknote/react` |",
  "| Licence | **MPL-2.0** |",
  "",
  "### DOMPurify",
  "",
  "| Offered under | MPL-2.0 **or** Apache-2.0 |",
  "| **Our election** | **Apache-2.0** |",
  "",
  "## Build and development tools",
  "",
  "These never reach a published artefact.",
  "",
  "| `lightningcss` | `1.32.0` | MPL-2.0 |",
  "| `axe-core` | `4.13.0` | MPL-2.0 |",
].join("\n");

/** One package under one licence expression, the shape pnpm reports. */
function groups(
  entries: Record<string, string[]>,
): Record<string, { name: string; versions: string[] }[]> {
  const out: Record<string, { name: string; versions: string[] }[]> = {};
  for (const [licence, names] of Object.entries(entries)) {
    out[licence] = names.map((name) => ({ name, versions: ["1.0.0"] }));
  }
  return out;
}

describe("licence-coverage", () => {
  it("passes a package whose every term is permissive", () => {
    const found = licenceCoverage(
      groups({ MIT: ["react"], "MIT OR Apache-2.0": ["zod"] }),
      NOTICE,
    );
    expect(found).toEqual([]);
  });

  it("reports a package with no entry", () => {
    const found = licenceCoverage(groups({ Unlicense: ["postgres"] }), NOTICE);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("postgres");
    expect(found[0]?.reason).toBe("missing");
  });

  it("reports a dual licence even when one half is permissive", () => {
    // Taking the MIT half is an election, and an election is the thing the
    // notice records — see its own DOMPurify entry.
    const found = licenceCoverage(
      groups({ "(MIT OR GPL-3.0-or-later)": ["jszip"] }),
      NOTICE,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("jszip");
  });

  it("reports an AND expression carrying a non-permissive term", () => {
    const found = licenceCoverage(groups({ "(MIT AND Zlib)": ["pako"] }), NOTICE);
    expect(found).toHaveLength(1);
  });

  it("reports a package with no licence metadata at all", () => {
    const found = licenceCoverage(
      groups({ Unknown: ["khroma"], UNLICENSED: ["@sesamecare-oss/redlock"] }),
      NOTICE,
    );
    expect(found).toHaveLength(2);
  });

  it("passes a package the notice covers with the same licence", () => {
    const found = licenceCoverage(
      groups({ "MPL-2.0": ["@blocknote/core", "@blocknote/react"] }),
      NOTICE,
    );
    expect(found).toEqual([]);
  });

  it("reports a package the notice names under a different licence", () => {
    const found = licenceCoverage(groups({ "MIT-0": [] }), NOTICE).concat(
      licenceCoverage(groups({ "GPL-3.0-only": ["@blocknote/core"] }), NOTICE),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toBe("licence-mismatch");
  });

  it("matches the name regardless of case", () => {
    // The notice writes `DOMPurify`; the package is `dompurify`.
    const found = licenceCoverage(
      groups({ "MPL-2.0 OR Apache-2.0": ["dompurify"] }),
      NOTICE,
    );
    expect(found).toEqual([]);
  });

  it("does not count a name that appears only under build and development tools", () => {
    // That section's whole point is to say those never ship. Reading a name
    // there as "declared" would go green on the state the file calls wrong.
    const found = licenceCoverage(groups({ "MPL-2.0": ["lightningcss"] }), NOTICE);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("lightningcss");
    expect(found[0]?.reason).toBe("missing");
  });
});
