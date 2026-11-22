// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { open, rm } from "node:fs/promises";
import { parseInstant } from "./instant-option.js";

/** What `pnpm db:tier-snapshot` was asked to do. */
export type TierSnapshotOptions = { help: true } | { help: false; at: Date; outputPath: string };

/** One account's line, the shape `membershipReadingsAt` yields. */
export interface SnapshotLineInput {
  userId: string;
  effectiveTier: string;
  limits: Readonly<Record<string, number>> | null;
  settlementProtected: boolean;
}

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
  if (!atText || !outputPath) {
    throw new Error("Expected one --at <ISO instant with a zone> and one --output <new file>");
  }
  return { help: false, at: parseInstant("--at", atText), outputPath };
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

/**
 * Write a snapshot to a new file, one line per row. The file is created only
 * if it does not exist, so a finished snapshot is never overwritten; when the
 * rows fail part way, the file this call created is removed, so a rerun can
 * use the same name.
 * @param rows - The readings, in account order.
 * @param outputPath - The file to create.
 * @param openFile - How the file is opened; tests hand one whose close fails.
 * @returns How many rows were written.
 * @throws {Error} When the file already exists (`EEXIST`), or reading or writing fails.
 */
export async function writeSnapshotFile(
  rows: AsyncIterable<SnapshotLineInput>,
  outputPath: string,
  openFile: typeof open = open,
): Promise<number> {
  const output = await openFile(outputPath, "wx", 0o600);
  let written = 0;
  try {
    for await (const row of rows) {
      await output.appendFile(formatSnapshotLine(row));
      written += 1;
    }
    await output.sync();
  } catch (err) {
    try {
      await output.close();
    } finally {
      await rm(outputPath, { force: true });
    }
    throw err;
  }
  await output.close();
  return written;
}
