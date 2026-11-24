// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Reading what a Space was told about its task rows: the `space-tasks-version` events on the task-events stream for
 * its document (inner#2061).
 */

import { getStreamRedis, taskEventsStreamKey } from "@breatic/core";

/**
 * The id of the newest entry on the task-events stream, taken before an action so only what the action sent is read.
 * @returns The id, or `0-0` on an empty stream.
 */
export async function streamMark(): Promise<string> {
  const last = (await getStreamRedis().xrevrange(taskEventsStreamKey(), "+", "-", "COUNT", 1)) as [string, string[]][];
  return last[0]?.[0] ?? "0-0";
}

/**
 * The `space-tasks-version` events for one Space document after a mark, waiting briefly for the first to arrive.
 * @param docName - The Space document.
 * @param since - A mark from {@link streamMark}; entries at or before it are left out.
 * @returns The events, oldest first.
 */
export async function spaceTasksChanges(docName: string, since = "0-0"): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const raw = (await getStreamRedis().xrange(taskEventsStreamKey(), `(${since}`, "+")) as [string, string[]][];
    const mine = raw
      .map(([, fields]) => JSON.parse(fields[fields.indexOf("payload") + 1]!) as Record<string, unknown>)
      .filter((event) => event.type === "space-tasks-version" && event.docName === docName);
    if (mine.length > 0 || Date.now() > deadline) return mine;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
