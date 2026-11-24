// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MONOREPO_ROOT } from "@breatic/core";
import { z } from "zod";
import {
  readBusinessMigrationWatermark,
  type BusinessMigrationWatermark,
} from "@server/modules/deployment/migration-watermark.repo.js";

const releaseIdentity = z.object({
  releaseVersion: z.string().regex(/^(?:0\.0\.0-dev|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?)$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
});
const journalEntries = z.object({ entries: z.array(z.object({ when: z.number().int().nonnegative() })) });

export type DeploymentVersion = z.infer<typeof releaseIdentity> & {
  expectedBusinessMigration: BusinessMigrationWatermark;
  actualBusinessMigration: BusinessMigrationWatermark;
};

/**
 * Combine the executing image's build identity with its expected and observed business schema watermarks.
 * @returns The version and migration metadata belonging to this server.
 * @throws {Error} When the image identity, migration journal or database ledger is unavailable.
 */
export async function getDeploymentVersion(): Promise<DeploymentVersion> {
  const identity = releaseIdentity.parse(JSON.parse(await readFile(resolve(MONOREPO_ROOT, "build-info.json"), "utf8")));
  const journal = journalEntries.parse(JSON.parse(await readFile(
    resolve(MONOREPO_ROOT, "packages/core/src/db/migrations/meta/_journal.json"), "utf8",
  )));
  const expectedBusinessMigration = {
    count: journal.entries.length,
    watermark: journal.entries.length === 0 ? null : Math.max(...journal.entries.map((entry) => entry.when)),
  };
  return { ...identity, expectedBusinessMigration, actualBusinessMigration: await readBusinessMigrationWatermark() };
}
