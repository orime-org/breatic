// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Background work of a Space in its own document (root `AGENTS.md#space-task-state-lives-in-the-space-document`):
 * the records stay in SQL, and the Space's document holds the task-events stream id of the last change to any of
 * them, which collab writes and every open tab of the Space watches to read its lists again.
 */

import type { SpaceType } from "@shared/types/space.js";

/** The Space types whose documents take a change version: collab writes it and web watches it, from this one list. */
export const SPACE_TASKS_TYPES: ReadonlySet<SpaceType> = new Set<SpaceType>(["timeline"]);

/** The root map of a Space document that holds its background work's change version. */
export const SPACE_TASKS_KEY = "spaceTasks";

/** The field of that map holding the stream id of the last change. */
export const SPACE_TASKS_VERSION = "version";

/** A Space's background work changed; collab writes the entry's stream id into the Space's document. */
export interface SpaceTasksVersionEvent {
  type: "space-tasks-version";
  /** The Yjs document of the Space the work belongs to. */
  docName: string;
}
