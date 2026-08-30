// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two rules the per-user tab order needs on both sides of the wire.
 *
 * Both live here because collab and the browser each apply them and the two
 * have to agree: collab seeds a user's list and normalises it before a
 * reorder, the browser dedupes what it reads and builds the first-visit
 * default. A rule that drifted between the two would put a different order
 * on screen than the one in the document.
 */

/** One Space, reduced to what deciding its place in the tab bar needs. */
export interface TabOrderEntry {
  /** The Space's id. */
  id: string;
  /** Epoch milliseconds from the Space entry, absent on entries written before the field existed. */
  createdAt: number | undefined;
}

/**
 * Drop repeated ids, keeping each one where it first appears.
 *
 * A Y.Array move is a delete plus an insert, so two collab instances that
 * have not synced yet can each move the same tab and leave the merged array
 * holding it twice (measured, `demo/2026-08-30-yjs-concurrent-move.mjs`).
 * Both replicas agree on that array, so deduping it deterministically leaves
 * them agreeing on what the tab bar shows.
 * @param ids - The order as stored, possibly holding an id more than once.
 * @returns A new array with each id once, in first-seen order.
 */
export function dedupeTabOrder(ids: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Put a project's Spaces in the order a tab bar shows them before the user
 * has arranged anything.
 *
 * Both places that produce that starting order call this: collab when it
 * seeds a user's list, and the browser when it renders a user who has no
 * list yet. Each reads the same `spaces` Y.Map, and `Y.Map` iteration order
 * is integration order — two replicas can disagree on it (measured,
 * `demo/2026-08-30-key-collision-and-map-order.mjs`), so leaving either side
 * on iteration order makes the untouched tabs jump the first time somebody
 * drags one.
 *
 * `createdAt` is the only field carrying time, so the starting order is the
 * order the Spaces were made. Entries without it are older than every
 * timestamped one and sort to the front. Ids break every tie, which is what
 * makes the result identical on any replica.
 * @param entries - The project's Spaces, in any order.
 * @returns Their ids, ordered.
 */
export function sortSpaceIdsForTabOrder(
  entries: ReadonlyArray<TabOrderEntry>,
): string[] {
  return [...entries]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        if (a.createdAt === undefined) return -1;
        if (b.createdAt === undefined) return 1;
        return a.createdAt - b.createdAt;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((e) => e.id);
}
