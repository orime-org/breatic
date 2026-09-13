// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLicenceNotice,
  NOTICE_COVERS,
  SHIPPED_NOTICE,
} from "#repo-lint/licence-notice";
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const notice = buildLicenceNotice(readLicenceReport(root, NOTICE_COVERS));
writeFileSync(join(root, SHIPPED_NOTICE), notice, "utf8");
process.stdout.write(`${SHIPPED_NOTICE}: ${notice.split("\n").length} lines\n`);
