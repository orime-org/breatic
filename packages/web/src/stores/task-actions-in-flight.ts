// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The task-row requests still waiting for their answer (inner#1374).
 *
 * Outside the task panel so it outlives the panel: closing the list and
 * opening it again finds the button still waiting, and a Retry cannot be
 * pressed twice for one File. Keyed like the retry stash
 * (`spaces/canvas/upload-retry-files.ts`) — project, space, task — plus the
 * request pressed, so one row's Retry and Clear each wait on their own.
 */

import { create } from 'zustand';

/**
 * The two requests a task row sends. Finish and Clear are the same dismiss
 * request (§7.4); View sends nothing.
 */
export type TaskActionRequest = 'retry' | 'dismiss';

/** The requests waiting, and the two ways a press enters and leaves. */
interface TaskActionsInFlightState {
  /** {@link taskActionKey} of every request waiting on the server. */
  inFlight: ReadonlySet<string>;
  /** Mark a request as waiting. */
  start: (key: string) => void;
  /** Mark a request as answered. */
  end: (key: string) => void;
}

export const useTaskActionsInFlight = create<TaskActionsInFlightState>()((set) => ({
  inFlight: new Set(),
  start: (key) => set((s) => ({ inFlight: new Set(s.inFlight).add(key) })),
  end: (key) =>
    set((s) => {
      const next = new Set(s.inFlight);
      next.delete(key);
      return { inFlight: next };
    }),
}));

/**
 * The store key for one request on one task row.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The task.
 * @param request - Which of the row's requests was pressed.
 * @returns The key.
 */
export function taskActionKey(
  projectId: string,
  spaceId: string,
  taskId: string,
  request: TaskActionRequest,
): string {
  return `${projectId}/${spaceId}/${taskId}/${request}`;
}

/**
 * Hold a request as waiting until the work behind its press settles, either
 * way.
 * @param key - The request's {@link taskActionKey}.
 * @param work - The press's work.
 */
export function trackTaskAction(key: string, work: Promise<unknown>): void {
  const { start, end } = useTaskActionsInFlight.getState();
  start(key);
  void work.then(
    () => end(key),
    () => end(key),
  );
}
