// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Open or close verified collection coverage using the current server clock. */
import { findRoot, loadEnv } from "./load-env.js";
import { parseActivityCoverageOptions } from "./activity-coverage-options.js";

const options = parseActivityCoverageOptions(process.argv.slice(2));
if (options.help) {
  console.log("Usage: pnpm db:activity-coverage <open|close> --version <positive-integer> --operator <operator-id>");
} else {
  loadEnv(findRoot());
  const loaded: unknown = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
  const core = loaded as typeof import("../packages/core/src/index.js");
  core.initCore(process.env);
  core.initLogger("activity-coverage");
  core.logger.info({ ...options }, "Activity coverage operation started");
  try {
    const at = new Date();
    const interval = options.action === "open"
      ? await core.accountActivityCoverageRepo.openActivityCoverage(options.version, at)
      : await core.accountActivityCoverageRepo.closeActivityCoverage(options.version, at);
    core.logger.info({ ...options, interval }, "Activity coverage operation completed");
  } catch (err) {
    core.logger.error({ err, ctx: { ...options } }, "Activity coverage operation failed");
    throw err;
  } finally {
    await core.closeDb();
  }
}
