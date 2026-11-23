// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
import { describe, expect, it } from "vitest";
import { fakeContext } from "#repo-lint/__tests__/fake-context";
import { noPreviousLicenceHeader } from "#repo-lint/checks/no-previous-licence-header";

// Built from pieces so this file does not itself carry the line it tests for.
const PREVIOUS = "SPDX-License-Identifier: " + "AGPL-3.0-only";
const CURRENT = "SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0";

describe("no-previous-licence-header", () => {
  it("reports a tracked file that still carries the previous SPDX line, with its line number", async () => {
    const findings = await noPreviousLicenceHeader.run(
      fakeContext({
        "packages/web/src/a.ts": `// Copyright (c) 2026 Orime, Inc.\n// ${PREVIOUS}\n`,
        "packages/core/src/db/migrations/0001_x.sql": `-- ${PREVIOUS}\nSELECT 1;\n`,
        "packages/web/src/b.ts": `// Copyright (c) 2026 Orime, Inc.\n// ${CURRENT}\n`,
      }),
    );
    expect(findings.map((f) => [f.file, f.line])).toEqual([
      ["packages/web/src/a.ts", 2],
      ["packages/core/src/db/migrations/0001_x.sql", 1],
    ]);
  });

  it("passes when every file carries the current line", async () => {
    const findings = await noPreviousLicenceHeader.run(
      fakeContext({ "scripts/x.sh": `#!/bin/sh\n# ${CURRENT}\n` }),
    );
    expect(findings).toEqual([]);
  });
});
