// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Test-only builders for the project meta doc.
 *
 * These used to live in `project-meta.ts` as exported functions, with a
 * docstring saying they were kept for tests and scaffolding. They were:
 * no production path called either one. Now that the client cannot write
 * the meta doc at all (task #27), leaving a pair of exported writers in
 * the module that documents "the client writes nothing here" would be a
 * standing contradiction — so they moved to where their only callers are.
 *
 * They write the same field shape collab's `writeSpaceEntry` produces,
 * which is what the shape tests rely on: the point of those tests is
 * that `spaces` is a `Y.Map` keyed by id, not a `Y.Array`, and getting
 * that wrong once broke Space creation end to end.
 */

import * as Y from 'yjs';

import { getDoc, docName } from '@web/data/yjs/manager';
import type { ProjectSpace } from '@web/data/yjs/project-meta';

/**
 * Put a Space entry into a project's meta doc, the way the server would.
 * @param projectId - Project whose meta doc to write into.
 * @param space - The Space to add.
 */
export function seedSpaceEntry(projectId: string, space: ProjectSpace): void {
  const doc = getDoc(docName.projectMeta(projectId));
  const spacesMap = doc.getMap<Y.Map<unknown>>('spaces');
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    entry.set('id', space.id);
    entry.set('name', space.name);
    entry.set('type', space.type);
    if (space.locked) entry.set('locked', true);
    if (space.claimToken !== undefined) {
      entry.set('claimToken', space.claimToken);
    }
    spacesMap.set(space.id, entry);
  });
}

/**
 * Remove a Space entry from a project's meta doc.
 * @param projectId - Project whose meta doc to write into.
 * @param spaceId - The Space to remove.
 */
export function removeSpaceEntry(projectId: string, spaceId: string): void {
  const doc = getDoc(docName.projectMeta(projectId));
  const spacesMap = doc.getMap<Y.Map<unknown>>('spaces');
  doc.transact(() => {
    if (spacesMap.has(spaceId)) spacesMap.delete(spaceId);
  });
}

/**
 * Give a user an open-tab list containing exactly these Spaces.
 *
 * Seeding the list directly, rather than replaying whatever the server
 * would write, keeps cases that only need "this user has tabs open" from
 * depending on the tab RPC's own rules. Those rules are pinned where
 * they live, in the collab handler tests.
 * @param projectId - Project whose meta doc to write into.
 * @param userId - Whose tab bar to seed.
 * @param spaceIds - The Spaces to list as open, in order.
 */
export function seedOpenTabs(
  projectId: string,
  userId: string,
  spaceIds: readonly string[],
): void {
  const doc = getDoc(docName.projectMeta(projectId));
  doc.transact(() => {
    const perUser = doc.getMap<Y.Map<unknown>>('perUser');
    let userMap = perUser.get(userId);
    if (!userMap) {
      userMap = new Y.Map<unknown>();
      perUser.set(userId, userMap);
    }
    const list = new Y.Array<string>();
    userMap.set('openTabIds', list);
    list.push([...spaceIds]);
  });
}
