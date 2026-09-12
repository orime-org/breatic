// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLicenceNotice } from "#repo-lint/licence-notice";
import { readLicenceReport } from "#repo-lint/licence-report";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Write the licence notice that ships inside the front-end bundle.
 *
 * Lives beside `notice-travels-with-the-bundle`, which fails when what this
 * writes and what the repository holds have parted ways. Run it whenever the
 * front end's dependencies change.
 */

/** Where vite picks the file up from and copies it into the bundle. */
const SHIPPED = "packages/web/public/third-party-licences.txt";

/** The workspace package whose production closure the notice covers. */
const COVERS = "@breatic/web";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const notice = buildLicenceNotice(readLicenceReport(root, COVERS));
writeFileSync(join(root, SHIPPED), notice, "utf8");
process.stdout.write(`${SHIPPED}: ${notice.split("\n").length} lines\n`);
