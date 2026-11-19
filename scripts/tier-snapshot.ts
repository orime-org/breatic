// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Membership snapshot for the billing cutover (inner#1993 §9.3 steps 3 and
 * 8): every live account's effective tier, its six limits and whether
 * subscription settlement protects it, read at `--at` instead of the clock,
 * one JSON line per account in account id order. Two snapshots of the same
 * moment compare with `cmp`.
 */

import { open } from "node:fs/promises";
import { findRoot, loadEnv } from "./load-env.js";
import { formatSnapshotLine, parseTierSnapshotOptions } from "./tier-snapshot-options.js";

/** Accounts read per query. */
const PAGE_SIZE = 500;

const options = parseTierSnapshotOptions(process.argv.slice(2));
if (options.help) {
  console.log("Usage: pnpm db:tier-snapshot --at <ISO instant with zone> --output <new file>");
} else {
  loadEnv(findRoot());
  const loaded: unknown = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
  const core = loaded as typeof import("../packages/core/src/index.js");
  core.initCore(process.env);
  core.initLogger("tier-snapshot");
  const output = await open(options.outputPath, "wx", 0o600);
  let accounts = 0;
  try {
    let after: string | null = null;
    for (;;) {
      const page = await core.listMembershipReadingsAt(options.at, after, PAGE_SIZE);
      for (const row of page) await output.appendFile(formatSnapshotLine(row));
      accounts += page.length;
      if (page.length < PAGE_SIZE) break;
      after = page[page.length - 1]!.userId;
    }
    await output.sync();
    core.logger.info({ at: options.at.toISOString(), output: options.outputPath, accounts }, "tier_snapshot_written");
  } catch (err) {
    core.logger.error({ err, at: options.at.toISOString(), output: options.outputPath }, "tier_snapshot_failed");
    process.exitCode = 1;
  } finally {
    await output.close();
    await core.closeDb();
  }
}
