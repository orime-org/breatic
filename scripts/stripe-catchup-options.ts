// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { parseInstant } from "./instant-option.js";

/** What `pnpm stripe:catchup` was asked to do. */
export type StripeCatchUpOptions = { help: true } | { help: false; since: Date };

/**
 * Parse the catch-up's arguments: `--since <ISO instant with zone>`.
 * @param args - The command-line arguments after the script name.
 * @returns Help, or the moment processing stopped.
 * @throws {Error} When `--since` is missing, not an absolute instant, or other arguments are given.
 */
export function parseStripeCatchUpOptions(args: string[]): StripeCatchUpOptions {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const [flag, value, ...rest] = args;
  if (flag !== "--since" || value === undefined || rest.length > 0) {
    throw new Error("Expected exactly --since <ISO instant with a zone>, the moment processing stopped");
  }
  return { help: false, since: parseInstant("--since", value) };
}
