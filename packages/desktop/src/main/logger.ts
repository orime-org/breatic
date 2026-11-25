// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The client's log file. The main process is the application layer, so every
 * catch in it logs here; the file is what a user sends when reporting a
 * problem.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import pino, { type Logger } from "pino";

/**
 * Open the log file in the given directory.
 * @param dir - `app.getPath("logs")`.
 * @param brandId - The build's brand, recorded on every line.
 * @returns The logger.
 * @throws {Error} if the directory cannot be created.
 */
export function createLogger(dir: string, brandId: string): Logger {
  mkdirSync(dir, { recursive: true });
  return pino({ base: { app: `${brandId}-desktop` } }, pino.destination({ dest: join(dir, "main.log"), sync: false }));
}
