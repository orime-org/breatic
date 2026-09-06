// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one task row offers the reader (#186 §7.1).
 *
 * Pure, and told everything it needs: neither of the two conditions is
 * visible from the row itself — whether this session still holds the File
 * (§3.7.2) and whether the task left a result behind (§3.3) both come from
 * elsewhere. Passing them in keeps the table readable as a table.
 */

import type { TaskStatus } from '@web/spaces/canvas/tasks/TaskStatusBadge';

/**
 * A button a task row can carry.
 *
 * `finish` and `clear` are the same request (§7.4) and differ only in the
 * word: one ends something that worked, the other files away something that
 * did not.
 */
export type TaskRowAction = 'replace' | 'retry' | 'finish' | 'clear';

/** Everything the rule needs to know about one row. */
export interface TaskRowSituation {
  /** Which of the four states the task is in. */
  status: TaskStatus;
  /** Whether it left content behind that could be written onto the node. */
  hasResult: boolean;
  /** Whether this session still holds the File this upload was carrying. */
  hasRetryFile: boolean;
  /**
   * Whether this reader may write. B4 admits a read-only member to the list,
   * and every button here is a write — each refusing in its own way once
   * pressed, one of them without saying anything.
   */
  readOnly: boolean;
}

/**
 * The buttons one task row shows, in the order they read.
 *
 * The acting button comes first and the one that makes the row go away comes
 * second, so the destructive end of the row is always in the same place.
 * @param situation - The row's state and its two outside conditions.
 * @param situation.status - Which of the four states the task is in.
 * @param situation.hasResult - Whether it left content behind.
 * @param situation.hasRetryFile - Whether this session still holds its File.
 * @param situation.readOnly - Whether this reader may write.
 * @returns The row's buttons, empty while the task is still running and for a
 *   reader who cannot write.
 */
export function taskRowActions({
  status,
  hasResult,
  hasRetryFile,
  readOnly,
}: TaskRowSituation): TaskRowAction[] {
  if (readOnly) return [];
  switch (status) {
    // Nothing about it is settled, so every button would act on a moving
    // target.
    case 'running':
      return [];
    case 'done':
      return hasResult ? ['replace', 'finish'] : ['finish'];
    // A failure produced nothing to write, whatever the row happens to
    // carry; the way forward is to run it again, not to keep anything.
    case 'failed':
      return hasRetryFile ? ['retry', 'clear'] : ['clear'];
    // §4.5: a report can arrive after the verdict. The bytes are real, so
    // the reader gets to put them on the node.
    case 'expired':
      return hasResult ? ['replace', 'clear'] : ['clear'];
  }
}
