// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The rules the tab bar orders itself by.
 *
 * The bar is runtime state of one browser tab and nothing stores it (user
 * 2026-09-12), so these are pure functions the reducer in
 * `web/pages/project/tab-state.ts` calls. They live here rather than beside
 * it because the ordering rule is a fact about Spaces, not about React.
 */

/** One Space, reduced to what deciding its place in the tab bar needs. */
export interface TabOrderEntry {
  /** The Space's id. */
  id: string;
  /** Epoch milliseconds from the Space entry, absent on entries written before the field existed. */
  createdAt?: number;
}

/**
 * Apply one relative move to a list of tab ids.
 *
 * The tab bar applies this the moment the user lets go; the order it
 * produces is what the strip shows and the only copy of it there is.
 *
 * Every copy of the moved id comes out and one goes back, so a list that
 * held it twice comes out of a move holding it once.
 * @param ids - The list as it stands.
 * @param spaceId - The tab being moved.
 * @param beforeSpaceId - The tab it lands in front of, null for the end.
 * @returns A new list with the move applied, unchanged when `spaceId` is not
 *   in the list or `beforeSpaceId` is neither null nor in it.
 */
export function applyTabMove(
  ids: ReadonlyArray<string>,
  spaceId: string,
  beforeSpaceId: string | null,
): string[] {
  if (!ids.includes(spaceId)) return [...ids];
  if (beforeSpaceId !== null && !ids.includes(beforeSpaceId)) return [...ids];
  if (spaceId === beforeSpaceId) return [...ids];
  const without = ids.filter((id) => id !== spaceId);
  if (beforeSpaceId === null) return [...without, spaceId];
  const at = without.indexOf(beforeSpaceId);
  return [...without.slice(0, at), spaceId, ...without.slice(at)];
}

/**
 * Put a project's Spaces in the order a tab bar shows them before the user
 * has arranged anything.
 *
 * `Y.Map` iteration order is integration order and two replicas can disagree
 * on it (measured, `demo/2026-08-30-key-collision-and-map-order.mjs`), so an
 * order taken from iteration would put a different Space on screen depending
 * on which replica answered. Sorting by a stored field answers the same way
 * everywhere.
 *
 * `createdAt` is the only field carrying time, so the starting order is the
 * order the Spaces were made. Entries without it are older than every
 * timestamped one and sort to the front. Ids break every tie, which is what
 * makes the result identical on any replica.
 * @param entries - The project's Spaces, in any order.
 * @returns Their ids, ordered.
 */
function sortSpaceIdsForTabOrder(
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

/**
 * The tabs a member has open before they have ever touched their tab bar.
 *
 * One Space, the newest, so opening a project connects one content document
 * instead of one per Space. This is what a project opens on every time: the
 * tab bar is runtime state of one browser tab and nothing stores it (task
 * #2144).
 * @param entries - The project's Spaces, in any order.
 * @returns The newest Space's id alone, or an empty list for a project with
 *   no Spaces.
 */
export function initialOpenTabIds(
  entries: ReadonlyArray<TabOrderEntry>,
): string[] {
  const ordered = sortSpaceIdsForTabOrder(entries);
  const newest = ordered[ordered.length - 1];
  return newest === undefined ? [] : [newest];
}

/**
 * Whether two orders hold the same ids in the same places.
 *
 * Asked before writing a reordered strip, so a drag that lands where the tab
 * already was changes no state and re-renders nothing.
 * @param a - One order.
 * @param b - The other.
 * @returns True when writing either over the other would change nothing.
 */
export function sameTabOrder(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
