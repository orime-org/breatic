// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Read a value out of a parsed JSON response by key path.
 *
 * Every vendor buries the interesting field somewhere different
 * (`data.status`, `output.0.url`, `result.task.state`), so the transports
 * declare a path instead of each writing its own walk.
 */

/**
 * Extract a value from a nested object using a key path.
 * @param data - Source object
 * @param path - Array of keys (e.g. `["data", "status"]`)
 * @param defaultValue - Fallback if path not found
 * @returns The extracted value or defaultValue
 */
export function extractNested(
  data: Record<string, unknown>,
  path: string[],
  defaultValue: unknown = undefined,
): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (
      current !== null &&
      typeof current === "object" &&
      key in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return defaultValue;
    }
  }
  return current ?? defaultValue;
}
