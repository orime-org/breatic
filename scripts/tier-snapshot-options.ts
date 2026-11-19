// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** What `pnpm db:tier-snapshot` was asked to do. */
export type TierSnapshotOptions = { help: true } | { help: false; at: Date; outputPath: string };

/** One account's line, the shape `listMembershipReadingsAt` returns. */
export interface SnapshotLineInput {
  userId: string;
  effectiveTier: string;
  limits: Readonly<Record<string, number>> | null;
  settlementProtected: boolean;
}

/** An absolute instant: date, time and an explicit zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse the snapshot's arguments: `--at <ISO instant with zone>` and `--output <new file>`, in either order.
 * @param args - The command-line arguments after the script name.
 * @returns Help, or the moment to read at and the file to write.
 * @throws {Error} When either is missing or repeated, the instant has no zone, or other arguments are given.
 */
export function parseTierSnapshotOptions(args: string[]): TierSnapshotOptions {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--at" && name !== "--output") || !value || value.startsWith("--") || values.has(name)) {
      throw new Error("Expected one --at <ISO instant with a zone> and one --output <new file>");
    }
    values.set(name, value);
  }
  const atText = values.get("--at");
  const outputPath = values.get("--output");
  if (!atText || !outputPath || !INSTANT.test(atText)) {
    throw new Error("Expected one --at <ISO instant with a zone> and one --output <new file>");
  }
  const at = new Date(atText);
  if (Number.isNaN(at.getTime())) throw new Error(`--at ${atText} is not a valid instant`);
  return { help: false, at, outputPath };
}

/**
 * One snapshot line with fields and limit keys in a fixed order, so two
 * snapshots of the same accounts are equal byte for byte.
 * @param row - One account's reading.
 * @returns The JSON line, newline included.
 */
export function formatSnapshotLine(row: SnapshotLineInput): string {
  const limits = row.limits === null
    ? null
    : Object.fromEntries(Object.keys(row.limits).sort().map((key) => [key, row.limits![key]]));
  return `${JSON.stringify({ userId: row.userId, effectiveTier: row.effectiveTier, limits, settlementProtected: row.settlementProtected })}\n`;
}
