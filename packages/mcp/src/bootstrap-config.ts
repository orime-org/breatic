// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Configuration bootstrap, the first import of the entry. It loads the root
 * `.env` in development, validates the variables this service reads and
 * builds the logger from them. It never calls `initCore`, so core's
 * configured singletons stay out of this package (breatic#1488 §13).
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { initLogger, MONOREPO_ROOT } from "@breatic/core";
import { parseMcpEnv, type McpEnv } from "@mcp/config.js";

loadDotenv({ path: resolve(MONOREPO_ROOT, ".env") });

/**
 * Validate the environment or stop the process.
 * @returns The validated environment.
 */
function loadMcpEnv(): McpEnv {
  try {
    return parseMcpEnv(process.env);
  } catch (err) {
    // The logger is built from this environment, so stderr is all there is.
    console.error("FATAL: invalid configuration at startup -", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/** The validated environment of this process. */
export const mcpEnv = loadMcpEnv();

initLogger("mcp", {
  logsRoot: resolve(MONOREPO_ROOT, "logs"),
  debug: mcpEnv.DEBUG,
  console: mcpEnv.ENV === "dev" ? "pretty" : "json",
});
