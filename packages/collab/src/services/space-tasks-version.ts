// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Space's background work change version in its own document (root
 * `AGENTS.md#space-task-state-lives-in-the-space-document`): the stream id of the last change, so every open tab of
 * the Space reads its lists again when it moves. The document holds the version itself, so an older change replayed
 * from the dead-letter stream is told apart without a second record.
 */

import type * as Y from "yjs";
import { parseDocName, SPACE_TASKS_KEY, SPACE_TASKS_VERSION, timelineSpaceDocName } from "@breatic/shared";
import { isNewerStreamId } from "@collab/services/stream-id.js";
import { liveDocNamesStartingWith } from "@collab/services/yjs-documents.repo.js";

/** A Project id as the stream may carry it; every named id is checked here before it builds a document name. */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The other Space documents a change passes on to: a run can sit as a placeholder waiting for its result in any
 * Timeline of a Project holding a grant to it (#1490 design §8), its own and any copy, so the change reaches every live
 * Timeline of the Projects the event names. An event naming none is from before the field; a Motion Space's change
 * then reaches its own Project's Timelines.
 * @param docName - The Space document the change was written into.
 * @param projects - The Projects the event names, or undefined when it names none.
 * @returns The documents that take the same change.
 * @throws {Error} When the Yjs database read fails.
 */
export async function docsFollowingChange(docName: string, projects: readonly string[] | undefined): Promise<string[]> {
  const parsed = parseDocName(docName);
  if (parsed === null) return [];
  const named = projects ?? (parsed.kind === "web_animation" ? [parsed.projectId] : []);
  const names = new Set<string>();
  for (const projectId of new Set(named)) {
    if (!PROJECT_ID.test(projectId)) continue;
    for (const name of await liveDocNamesStartingWith(timelineSpaceDocName(projectId, ""))) names.add(name);
  }
  names.delete(docName);
  return [...names];
}

/**
 * Write a change's stream id into the Space document unless it already holds a newer one.
 * @param doc - The Space document, inside the writer's transaction.
 * @param version - The change's stream id (its origin id when replayed).
 * @throws {Error} When the version is not a stream id.
 */
export function applySpaceTasksVersion(doc: Y.Doc, version: string): void {
  const map = doc.getMap(SPACE_TASKS_KEY);
  if (isNewerStreamId(version, map.get(SPACE_TASKS_VERSION))) map.set(SPACE_TASKS_VERSION, version);
}
