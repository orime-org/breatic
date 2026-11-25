// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { parseInstant } from "./instant-option.js";

/** Which dead letters to requeue: by id, or by reason given up since an instant. */
export type RequeueSelection = { ids: string[] } | { reason: string; since: Date };

/** What `pnpm commerce:requeue-dead-letters` was asked to do. */
export type RequeueOptions = { help: true } | { help: false; apply: boolean; again: boolean; selection: RequeueSelection };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE =
  "Expected --id <dead-letter id> (repeatable) [--again], or one --reason <reason> with one --since <ISO instant with a zone>; add --apply to write";

/**
 * Parse the requeue script's arguments.
 * @param args - The command-line arguments after the script name.
 * @returns Help, or which dead letters to pick, whether to write and whether to requeue ones already requeued.
 * @throws {Error} When nothing or both ways are selected, `--again` comes without ids, a value is missing or malformed, or an argument is unknown.
 */
export function parseRequeueOptions(args: string[]): RequeueOptions {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const ids: string[] = [];
  let reason: string | undefined;
  let sinceText: string | undefined;
  let apply = false;
  let again = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--apply") {
      apply = true;
      continue;
    }
    if (name === "--again") {
      again = true;
      continue;
    }
    const value = args[index + 1];
    index += 1;
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (name === "--id" && UUID.test(value)) ids.push(value);
    else if (name === "--reason" && reason === undefined) reason = value;
    else if (name === "--since" && sinceText === undefined) sinceText = value;
    else throw new Error(USAGE);
  }
  const byReason = reason !== undefined || sinceText !== undefined;
  if (ids.length > 0 && !byReason) return { help: false, apply, again, selection: { ids } };
  if (ids.length === 0 && !again && reason !== undefined && sinceText !== undefined) {
    return { help: false, apply, again, selection: { reason, since: parseInstant("--since", sinceText) } };
  }
  throw new Error(USAGE);
}

/**
 * Which listed dead letters to requeue (inner#1993 §5.2). A selection by
 * reason skips the ones already requeued, so rerunning the same command after
 * a recovery does not send them once more; one named by id is requeued again
 * only with `--again`.
 * @param selection - How the dead letters were picked.
 * @param letters - The listed dead letters.
 * @param again - Whether `--again` was given.
 * @returns The letters to requeue, and the ones skipped as already requeued.
 * @throws {Error} When an id names a dead letter already requeued and `--again` was not given.
 */
export function pickRequeue<T extends { id: string; requeuedAt: Date | null }>(selection: RequeueSelection, letters: T[], again: boolean): { requeue: T[]; skipped: T[] } {
  if ("reason" in selection) return { requeue: letters.filter((l) => l.requeuedAt === null), skipped: letters.filter((l) => l.requeuedAt !== null) };
  const done = letters.find((l) => l.requeuedAt !== null);
  if (done !== undefined && !again) {
    throw new Error(`dead letter ${done.id} was already requeued at ${done.requeuedAt!.toISOString()}; pass --again to requeue it once more`);
  }
  return { requeue: letters, skipped: [] };
}
