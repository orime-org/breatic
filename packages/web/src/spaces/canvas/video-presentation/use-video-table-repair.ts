// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import type { VideoPresentationResponse } from '@breatic/shared';
import { sourceLedgerQuery } from '@web/spaces/canvas/video-presentation/source-ledger-query';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { createVideoPresentationRecovery } from '@web/spaces/canvas/video-presentation/video-presentation-recovery';

/** The one Retry of a video source's presentation table, for the current video and every picked input. */
export interface VideoTableRepair {
  /** Repairs this source's table and rereads it; a refusal is reported by the repair request itself. */
  repair: (canonicalURL: string) => void;
  /** The sources whose Retry is still waiting. */
  repairing: ReadonlySet<string>;
}

/**
 * The Retry every video tool surface offers on a source whose table failed (frames-split §7.12 retry column): repair the
 * source and reread its current table receipt, keyed per source so a press keeps waiting after the panel closes.
 * `repairVideoPresentation` already shows the refusal, so this adds no toast of its own.
 * @param projectId - The Project.
 * @returns The repair press and the sources still waiting.
 * @throws {never} Failures are reported by the repair request.
 */
export function useVideoTableRepair(projectId: string): VideoTableRepair {
  const queryClient = useQueryClient();
  const mutationKey = React.useMemo(() => ['video-table-repair', projectId], [projectId]);
  const { mutate } = useMutation({ mutationKey, mutationFn: async (canonicalURL: string): Promise<void> => {
    const input = { projectId, canonicalURL, active: true };
    const response = queryClient.getQueryData<VideoPresentationResponse>(videoPresentationQuery(input).queryKey);
    await createVideoPresentationRecovery(queryClient, input).recover('table');
    // A failed bounded read has no producer failure to clear. Reread its exact current receipt as well, without letting
    // the previous error or data win.
    if (response !== undefined) await queryClient.resetQueries({ queryKey: sourceLedgerQuery({ projectId, response, active: true }).queryKey, exact: true });
  } });
  const pending = useMutationState({ filters: { mutationKey, exact: true, status: 'pending' }, select: (mutation) => mutation.state.variables as string });
  const repairing = React.useMemo(() => new Set(pending), [pending]);
  return React.useMemo(() => ({ repair: mutate, repairing }), [mutate, repairing]);
}
