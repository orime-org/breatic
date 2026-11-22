// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { parseInstant } from "./instant-option.js";

/** Which dead letters to requeue: by id, or by reason given up since an instant. */
export type RequeueSelection = { ids: string[] } | { reason: string; since: Date };

/** What `pnpm commerce:requeue-dead-letters` was asked to do. */
export type RequeueOptions = { help: true } | { help: false; apply: boolean; selection: RequeueSelection };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = "Expected --id <dead-letter id> (repeatable), or one --reason <reason> with one --since <ISO instant with a zone>; add --apply to write";

/**
 * Parse the requeue script's arguments.
 * @param args - The command-line arguments after the script name.
 * @returns Help, or which dead letters to pick and whether to write.
 * @throws {Error} When nothing or both ways are selected, a value is missing or malformed, or an argument is unknown.
 */
export function parseRequeueOptions(args: string[]): RequeueOptions {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const ids: string[] = [];
  let reason: string | undefined;
  let sinceText: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--apply") {
      apply = true;
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
  if (ids.length > 0 && !byReason) return { help: false, apply, selection: { ids } };
  if (ids.length === 0 && reason !== undefined && sinceText !== undefined) {
    return { help: false, apply, selection: { reason, since: parseInstant("--since", sinceText) } };
  }
  throw new Error(USAGE);
}
