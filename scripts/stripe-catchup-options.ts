// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** What `pnpm stripe:catchup` was asked to do. */
export type StripeCatchUpOptions = { help: true } | { help: false; since: Date };

/** An absolute instant: date, time and an explicit zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse the catch-up's arguments: `--since <ISO instant with zone>`.
 * @param args - The command-line arguments after the script name.
 * @returns Help, or the moment processing stopped.
 * @throws {Error} When `--since` is missing, not an absolute instant, or other arguments are given.
 */
export function parseStripeCatchUpOptions(args: string[]): StripeCatchUpOptions {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const [flag, value, ...rest] = args;
  if (flag !== "--since" || value === undefined || rest.length > 0 || !INSTANT.test(value)) {
    throw new Error("Expected exactly --since <ISO instant with a zone>, the moment processing stopped");
  }
  const since = new Date(value);
  if (Number.isNaN(since.getTime())) throw new Error(`--since ${value} is not a valid instant`);
  return { help: false, since };
}
