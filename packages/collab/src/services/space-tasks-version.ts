// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A Space's background work change version in its own document (root
 * `AGENTS.md#space-task-state-lives-in-the-space-document`): the stream id of the last change, so every open tab of
 * the Space reads its lists again when it moves. The document holds the version itself, so an older change replayed
 * from the dead-letter stream is told apart without a second record.
 */

import type * as Y from "yjs";
import { SPACE_TASKS_KEY, SPACE_TASKS_VERSION, type DocKind } from "@breatic/shared";
import { isNewerStreamId } from "@collab/services/stream-id.js";

/** The Space types whose documents take a change version; another type joins by being listed here. */
export const SPACE_TASKS_DOC_KINDS: ReadonlySet<DocKind> = new Set<DocKind>(["web_animation", "timeline"]);

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
