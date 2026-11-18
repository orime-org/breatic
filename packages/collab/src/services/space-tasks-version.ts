// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A Space's background work change version in its own document (root
 * `AGENTS.md#space-task-state-lives-in-the-space-document`): the stream id of the last change, so every open tab of
 * the Space reads its lists again when it moves. The document holds the version itself, so an older change replayed
 * from the dead-letter stream is told apart without a second record.
 */

import type * as Y from "yjs";
import { parseDocName, SPACE_TASKS_KEY, SPACE_TASKS_VERSION, timelineSpaceDocName, type DocKind } from "@breatic/shared";
import { isNewerStreamId } from "@collab/services/stream-id.js";
import { liveDocNamesStartingWith } from "@collab/services/yjs-documents.repo.js";

/** The Space types whose documents take a change version; another type joins by being listed here. */
export const SPACE_TASKS_DOC_KINDS: ReadonlySet<DocKind> = new Set<DocKind>(["web_animation", "timeline"]);

/**
 * The other Space documents a change passes on to: a Motion run can sit in any Timeline of its Project as a
 * placeholder waiting for its result (#1490 design §8), so a Motion Space's change reaches every live Timeline too.
 * @param docName - The Space document the change was written into.
 * @returns The documents that take the same change.
 * @throws {Error} When the Yjs database read fails.
 */
export async function docsFollowingChange(docName: string): Promise<string[]> {
  const parsed = parseDocName(docName);
  if (parsed?.kind !== "web_animation") return [];
  return liveDocNamesStartingWith(timelineSpaceDocName(parsed.projectId, ""));
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
