// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QueryClient } from '@tanstack/react-query';
import { newId, type VideoPresentationResponse } from '@breatic/shared';
import { ApiException } from '@web/data/api/types';
import { repairVideoPresentation, videoPresentationQuery, type VideoPresentationQueryInput } from '@web/spaces/canvas/video-presentation/video-presentation-query';

/** Recovery distinguishes platform source work from a local renderer restart. */
export type VideoPresentationRecoveryReason = 'source' | 'renderer' | 'table';
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
   * candidate with nothing selected, a failed ledger of the selected version, or a failed table read; a candidate
   * still in progress is only reread.
   * @param reason - Whether the failure came from source preparation or the local renderer.
   * @throws {Error} The original repair failure or the source query failure.
   */
  async function execute(reason: VideoPresentationRecoveryReason): Promise<void> {
    if (reason === 'renderer') return;
    const data = client.getQueryData<VideoPresentationResponse>(queryKey);
    if (data !== undefined && (reason === 'table' || (data.presentation === null ? data.preparation?.failure != null : data.ledger?.state === 'failed'))) {
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
