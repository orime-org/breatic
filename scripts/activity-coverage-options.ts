// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Validated operator intent; timestamps always come from the running server. */
export type ActivityCoverageOptions = { help: true } | { help: false; action: "open" | "close"; version: number; operator: string };

/**
 * Validate an explicit collection-coverage operation.
 * @param args - Command arguments after the script name.
 * @returns Help or a complete operator intention.
 * @throws {Error} When arguments do not describe a permitted operation.
 */
export function parseActivityCoverageOptions(args: string[]): ActivityCoverageOptions {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const [action, ...flags] = args;
  if (action !== "open" && action !== "close") throw new Error("Expected open or close");
  const values = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if ((name !== "--version" && name !== "--operator") || !value || value.startsWith("--") || values.has(name)) {
      throw new Error("Expected one explicit --version and --operator; timestamps are server supplied");
    }
    values.set(name, value);
  }
  const versionText = values.get("--version");
  const version = Number(versionText);
  const operator = values.get("--operator")?.trim();
  if (!versionText || !/^\d+$/.test(versionText) || !Number.isSafeInteger(version) || version < 1 || !operator) {
    throw new Error("A positive integer version and nonempty operator are required");
  }
  return { help: false, action, version, operator };
}
