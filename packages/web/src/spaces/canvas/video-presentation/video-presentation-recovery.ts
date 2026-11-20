// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useMutation, useMutationState, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { newId, type VideoPresentationResponse } from '@breatic/shared';
import { ApiException } from '@web/data/api/types';
import { repairVideoPresentation, videoPresentationQuery, type VideoPresentationQueryInput } from '@web/spaces/canvas/video-presentation/video-presentation-query';

/** Recovery distinguishes platform source work from a local renderer restart. */
export type VideoPresentationRecoveryReason = 'source' | 'renderer';
/** One existing Retry action, whose concurrent invocations share a press. */
export interface VideoPresentationRecovery {
  recover: (reason: VideoPresentationRecoveryReason) => Promise<void>;
}

/** A UI-only source recovery capability, independent of the source wire DTO. */
export class VideoPresentationRecoveryError extends Error {
  /**
   * Keeps the failed decoder's canonical identity with its existing Retry action.
   * @param message - Stable source or renderer error.
   * @param canonicalURL - The actual source this recovery belongs to.
   * @param recover - Its account-bound explicit recovery operation.
   * @throws {never} Constructing the error performs no operation.
   */
  constructor(message: string, readonly canonicalURL: string, readonly recover: () => Promise<void>) {
    super(message);
    this.name = 'VideoPresentationRecoveryError';
  }
}

/**
 * Binds the existing Retry action to its account cache and canonical source.
 * @param client - The existing account-scoped query owner.
 * @param input - Current Project and canonical source identity.
 * @returns The shared node and timeline recovery action.
 * @throws {never} Constructing the action does not make a request.
 */
export function createVideoPresentationRecovery(client: QueryClient, input: VideoPresentationQueryInput): VideoPresentationRecovery {
  const options = videoPresentationQuery(input);
  const { queryKey } = options;
  let pending: Promise<void> | null = null;
  /**
   * Repairs only failed source work and then rereads authorized facts (§7.12 step 2 and the retry column): a failed
   * candidate with nothing selected; a candidate still in progress is only reread.
   * @param reason - Whether the failure came from source preparation or the local renderer.
   * @throws {Error} The original repair failure or the source query failure.
   */
  async function execute(reason: VideoPresentationRecoveryReason): Promise<void> {
    if (reason === 'renderer') return;
    const data = client.getQueryData<VideoPresentationResponse>(queryKey);
    if (data !== undefined && data.presentation === null && data.preparation?.failure != null) {
      try {
        await repairVideoPresentation({ projectId: input.projectId, canonicalURL: input.canonicalURL, sourceFingerprint: data.sourceBinding.contentHash }, newId());
      } catch (error) {
        // The repair client already reports the refusal. Refresh the actual
        // identity even when this press lost a source race, then preserve it.
        if (error instanceof ApiException && error.status === 409) await client.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined);
        throw error;
      }
    }
    // A cache populated without an observer need not have a queryFn yet.
    // Supply the actual public factory and bypass freshness for this read.
    await client.fetchQuery({ ...options, staleTime: 0 });
  }
  /**
   * Joins concurrent invocations of the same press without duplicating repair work.
   * @param reason - The failure's actual owner.
   * @returns This press's shared completion promise.
   * @throws {Error} Repair or reread failures reject the returned promise.
   */
  function recover(reason: VideoPresentationRecoveryReason): Promise<void> {
    if (pending !== null) return pending;
    pending = execute(reason).finally(() => { pending = null; });
    return pending;
  }
  return { recover };
}

/** The one Retry of a video source's presentation, for the current video and every picked input. */
export interface VideoPresentationRepair {
  /** Repairs this source and rereads it; a refusal is reported by the repair request itself. */
  repair: (canonicalURL: string) => void;
  /** The sources whose Retry is still waiting. */
  repairing: ReadonlySet<string>;
}

/**
 * The Retry every video tool surface offers on a source whose candidate failed (frames-split §7.12 retry column): repair the
 * source and reread it, keyed per source so a press keeps waiting after the panel closes. `repairVideoPresentation` already
 * shows the refusal, so this adds no toast of its own.
 * @param projectId - The Project.
 * @returns The repair press and the sources still waiting.
 * @throws {never} Failures are reported by the repair request.
 */
export function useVideoPresentationRepair(projectId: string): VideoPresentationRepair {
  const queryClient = useQueryClient();
  const mutationKey = React.useMemo(() => ['video-presentation-repair', projectId], [projectId]);
  const { mutate } = useMutation({ mutationKey, mutationFn: (canonicalURL: string): Promise<void> => createVideoPresentationRecovery(queryClient, { projectId, canonicalURL, active: true }).recover('source') });
  const pending = useMutationState({ filters: { mutationKey, exact: true, status: 'pending' }, select: (mutation) => mutation.state.variables as string });
  const repairing = React.useMemo(() => new Set(pending), [pending]);
  return React.useMemo(() => ({ repair: mutate, repairing }), [mutate, repairing]);
}
