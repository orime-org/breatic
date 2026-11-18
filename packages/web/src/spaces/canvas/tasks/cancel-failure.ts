// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { serverWords } from '@web/data/api/server-message';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';

/**
 * Tell the user a cancel of a queued task did not go through (inner#1968),
 * the same from a node's task list and a 3D Space's: a task that started
 * meanwhile is a rule stopping the press, so the server's sentence is a
 * warning; anything else is an error, in the server's words when it wrote
 * some.
 * @param err - What the cancel rejected with.
 * @param cancelFailed - The sentence for a cancel that never reached us, translated.
 */
export function toastCancelFailure(err: unknown, cancelFailed: string): void {
  const said = serverWords(err);
  if (said !== null && err instanceof ApiException && err.status === 409) toast.warning(said);
  else toast.error(said ?? cancelFailed);
}
