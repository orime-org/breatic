// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import {
  licenceCoverage,
  type LicensedPackage,
} from "#repo-lint/licence-coverage";

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
  "### Other packages in the bundle",
  "",
  "| Package | Version | Licence |",
  "|---|---|---|",
  "| `fractional-indexing` | `3.2.0` | **CC0-1.0** |",
  "| `robust-predicates` | `3.0.3` | **Unlicense** |",
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
): Record<string, LicensedPackage[]> {
  const out: Record<string, LicensedPackage[]> = {};
  for (const [licence, names] of Object.entries(entries)) {
    out[licence] = names.map((name) => ({
      name,
      versions: ["1.0.0"],
      paths: [`/repo/node_modules/${name}`],
      license: licence,
      homepage: "",
    }));
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

  it("judges a table row on its own line, not on its neighbours", () => {
    // Both live under one `### Other packages in the bundle` heading. Reading
    // the whole section as one entry lets either row's licence vouch for the
    // other, which is the exact thing the mismatch message says it catches.
    const found = licenceCoverage(
      groups({ Unlicense: ["fractional-indexing"] }),
      NOTICE,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toBe("licence-mismatch");
  });

  it("passes each row of a shared table under its own licence", () => {
    const found = licenceCoverage(
      groups({
        "CC0-1.0": ["fractional-indexing"],
        Unlicense: ["robust-predicates"],
      }),
      NOTICE,
    );
    expect(found).toEqual([]);
  });

  it("does not let one licence identifier pass as a prefix of another", () => {
    // The notice's redlock entry says UNLICENSED, meaning its metadata names
    // no licence. `Unlicense` is a real, different licence, and a plain
    // substring test reads the first as stating the second.
    const found = licenceCoverage(
      groups({ Unlicense: ["@sesamecare-oss/redlock"] }),
      [
        NOTICE.slice(0, NOTICE.indexOf("## Build and development tools")),
        "### Server-side packages under other licences",
        "",
        "| `@sesamecare-oss/redlock` | `1.4.0` | **UNLICENSED** |",
        "",
        "## Build and development tools",
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toBe("licence-mismatch");
  });

  it("accepts the entry that states the licence, not merely the first to name the package", () => {
    // Entries cross-reference each other, so a name appears in more than one.
    // Taking the first match makes a mention in someone else's prose stand in
    // for the package's own entry.
    const found = licenceCoverage(
      groups({ "MPL-2.0": ["@blocknote/core"] }),
      NOTICE.replace(
        "| Licence | **GPL-2.0-or-later** |",
        "| Licence | **GPL-2.0-or-later** | See the `@blocknote/core` entry.",
      ),
    );
    expect(found).toEqual([]);
  });

  it("throws when the notice has no build-and-development-tools heading", () => {
    // Without the heading the cut silently disappears and every name below it
    // starts counting as declared — a check reporting clean because it could
    // not find what it was supposed to read, which this repository forbids.
    expect(() =>
      licenceCoverage(
        groups({ "MPL-2.0": ["lightningcss"] }),
        NOTICE.replace("## Build and development tools", "## Tooling"),
      ),
    ).toThrow(/Build and development tools/);
  });
});
