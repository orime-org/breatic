// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The task rows whose Retry, Finish or Clear is still waiting for its answer
 * (inner#1374).
 *
 * Outside the task panel so it outlives the panel: closing the list and
 * opening it again finds the row still waiting, and a Retry cannot be pressed
 * twice for one File. Keyed like the retry stash
 * (`spaces/canvas/upload-retry-files.ts`): project, space, task.
 */

import { create } from 'zustand';

/** The rows waiting, and the two ways a press enters and leaves. */
interface TaskActionsInFlightState {
  /** `${projectId}/${spaceId}/${taskId}` of every row waiting on a press. */
  inFlight: ReadonlySet<string>;
  /** Mark a row as waiting. */
  start: (key: string) => void;
  /** Mark a row as answered. */
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
 * The store key for one task row.
 * @param projectId - Owning project.
 * @param spaceId - Space the task's node lives in.
 * @param taskId - The task.
 * @returns The key.
 */
export function taskActionKey(projectId: string, spaceId: string, taskId: string): string {
  return `${projectId}/${spaceId}/${taskId}`;
}

/**
 * Hold a row as waiting until the work behind its press settles, either way.
 * @param key - The row's {@link taskActionKey}.
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
