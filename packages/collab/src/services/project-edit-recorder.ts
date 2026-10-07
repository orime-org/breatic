// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Records that a project was edited, for the studio list's "last edited"
 * sort (inner#1020).
 *
 * Called after a Space document's store lands and after a Space is created,
 * renamed, locked, deleted or restored. Each instance writes a project at
 * most once per `project_edit_touch_interval_ms`: the list shows times like
 * "5 minutes ago", and a store lands every few seconds while someone types.
 *
 * The write is not awaited by its caller. A store holds the document's save
 * lock across both store hooks, and the business database has no say in
 * whether the content landed, so a failed write is logged and nothing more.
 */

import { createLogger, projectEditsRepo } from "@breatic/core";
import { getCollabConfig } from "@collab/config.js";

const logger = createLogger("collab-project-edits");

/** What a recorder needs. */
export interface ProjectEditRecorderDeps {
  /** Shortest gap between two writes of one project, in milliseconds. */
  intervalMs: number;
  /** The current time, in milliseconds. */
  now: () => number;
  /** Writes the project's edit time. */
  touch: (projectId: string) => Promise<void>;
  /** Told about a write that failed. */
  onError: (err: unknown, projectId: string) => void;
}

/** A recorder of project edits. */
export interface ProjectEditRecorder {
  /** Note that a project was edited now; writes unless it did so recently. */
  record: (projectId: string) => void;
  /** How many projects it currently remembers writing. */
  size: () => number;
}

/**
 * Build a recorder.
 *
 * It remembers when it last wrote each project and forgets a project once
 * the interval has passed, so it holds at most the projects written within
 * one interval.
 * @param deps - Its clock, interval and write.
 * @returns The recorder.
 */
export function createProjectEditRecorder(deps: ProjectEditRecorderDeps): ProjectEditRecorder {
  const lastWritten = new Map<string, number>();
  return {
    record: (projectId: string): void => {
      const now = deps.now();
      for (const [id, at] of lastWritten) {
        if (now - at >= deps.intervalMs) lastWritten.delete(id);
      }
      if (lastWritten.has(projectId)) return;
      lastWritten.set(projectId, now);
      // A write that throws before it returns a promise is reported the same
      // way as one that rejects, never to the caller.
      try {
        deps.touch(projectId).catch((err: unknown) => deps.onError(err, projectId));
      } catch (err) {
        deps.onError(err, projectId);
      }
    },
    size: (): number => lastWritten.size,
  };
}

let processRecorder: ProjectEditRecorder | undefined;

/**
 * Record that a project was edited, through this process's recorder.
 * @param projectId - The project that changed.
 */
export function recordProjectEdit(projectId: string): void {
  processRecorder ??= createProjectEditRecorder({
    intervalMs: getCollabConfig().project_edit_touch_interval_ms,
    now: Date.now,
    touch: (id) => projectEditsRepo.touchProjectEdit(id),
    onError: (err, id) => logger.error({ err, projectId: id }, "project_edit_record_failed"),
  });
  processRecorder.record(projectId);
}
