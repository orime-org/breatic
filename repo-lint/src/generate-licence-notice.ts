// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLicenceNotice, SHIPPED_NOTICES } from "#repo-lint/licence-notice";
import { readLicenceReport } from "#repo-lint/licence-report";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Write the licence notices that ship inside the front-end bundle and the desktop installer.
 *
 * Lives beside `notice-travels-with-the-bundle`, which fails when what this
 * writes and what the repository holds have parted ways. Run it whenever the
 * front end's or the desktop client's dependencies change.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
for (const { covers, path, artefact } of SHIPPED_NOTICES) {
  const notice = buildLicenceNotice(readLicenceReport(root, covers), artefact);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), notice, "utf8");
  process.stdout.write(`${path}: ${notice.split("\n").length} lines\n`);
}
