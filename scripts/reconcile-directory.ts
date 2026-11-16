// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Align the Studio directory with the global region's tables once, after its
 * upgrade, when every process of the previous release has exited
 * (inner#1955). A second run does nothing.
 */
import { findRoot, loadEnv } from "./load-env.js";

loadEnv(findRoot());
const loadedCore: unknown = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
const core = loadedCore as typeof import("../packages/core/src/index.js");
const loadedDomain: unknown = await import(new URL("../packages/domain/dist/index.js", import.meta.url).href);
const domain = loadedDomain as typeof import("../packages/domain/src/index.js");
core.initCore(process.env);
core.initLogger("reconcile-directory");
core.logger.info("Directory reconciliation started");
try {
  const aligned = await domain.studioDirectoryService.reconcileDirectoryAfterUpgrade();
  core.logger.info({ aligned }, "Directory reconciliation completed");
} catch (err) {
  core.logger.error({ err }, "Directory reconciliation failed");
  throw err;
} finally {
  await core.closeDb();
}
