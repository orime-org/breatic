// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who the stickies on a board name, and how a sticky reads a name back.
 *
 * One request for the whole board, not one per sticky. Every sticky names its
 * own author and the author of each reply, so a sticky asking for its own
 * people is a different id list, a different cache entry and a different
 * request: measured on a board of ten, ten `GET /users` for what one answers,
 * and a name shared by two stickies fetched twice and arriving at two
 * different moments.
 *
 * The names travel in a context of their own rather than on `CanvasContext`,
 * which carries what a node has to KNOW about its surroundings. These are
 * data, and a separate context also keeps a name arriving from redrawing
 * every node on the canvas — only the stickies read it.
 */

import * as React from 'react';

import type { UserSummary } from '@web/data/api/users';

/** Whatever a node view looks like, this is the part this file reads. */
interface MaybeAnnotation {
  data?: unknown;
}

/** The shape a sticky's node data has; anything else is not one. */
interface AnnotationShape {
  kind?: unknown;
  createdBy?: unknown;
  replies?: { createdBy?: unknown }[];
}

/** Nobody named yet — a stable identity, so a reader's memo can bail out. */
const NO_NAMES: ReadonlyMap<string, UserSummary> = new Map();

export const AnnotationNamesContext =
  React.createContext<ReadonlyMap<string, UserSummary>>(NO_NAMES);

/**
 * Everybody the stickies on this board name, once each, in a stable order.
 *
 * Sorted and de-duplicated, because the list becomes a query key: the same
 * board in a different node order has to be the same request, not a second
 * one. Reads the graph mirror rather than the elements, so a sticky panned
 * off screen still has its author named when it comes back.
 * @param nodes - Every node on the board, of any kind.
 * @returns The user ids to resolve, sorted, with no repeats.
 */
export function everyAnnotationAuthor(
  nodes: readonly MaybeAnnotation[],
): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    const data = node.data as AnnotationShape | undefined;
    if (data?.kind !== 'annotation') continue;
    if (typeof data.createdBy === 'string') ids.add(data.createdBy);
    for (const reply of data.replies ?? []) {
      if (typeof reply.createdBy === 'string') ids.add(reply.createdBy);
    }
  }
  return [...ids].sort();
}

/**
 * Read the names resolved for this board.
 * @returns The profiles by user id; empty while the request is in flight, and
 *   empty for anybody the endpoint did not answer for.
 */
export function useAnnotationNames(): ReadonlyMap<string, UserSummary> {
  return React.useContext(AnnotationNamesContext);
}
