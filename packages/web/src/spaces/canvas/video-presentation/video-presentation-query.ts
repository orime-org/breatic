// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { queryOptions, type UseQueryOptions } from '@tanstack/react-query';
import { t, videoPresentationResponseSchema, type VideoPresentationResponse } from '@breatic/shared';
import { apiGet, apiPost, runOnceRequest } from '@web/data/api/request';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';

/** Canonical source query inputs; the existing account-scoped client owns the cache. */
export interface VideoPresentationQueryInput { projectId: string; canonicalURL: string; active: boolean }
/** Explicit repair carries the actual registered source hash and a press identity. */
export interface VideoPresentationRepairInput { projectId: string; canonicalURL: string; sourceFingerprint: string }
/** The existing query cache stores only source facts, never a media element. */
export type VideoPresentationQueryOptions = UseQueryOptions<VideoPresentationResponse, Error, VideoPresentationResponse,
  readonly ['video-presentation', 1, string, string]>;

/**
 * Describe one authorized canonical source query without creating another cache. It is read again when collab says
 * the video's presentation job ended (`useProjectLiveUpdates`, frames-split §7.20), never on a timer.
 * @param input - Project, source and current Space activation.
 * @returns Options for the existing QueryClient or a normal query observer.
 * @throws {never} Merely constructing options does not start a request.
 */
export function videoPresentationQuery(input: VideoPresentationQueryInput): VideoPresentationQueryOptions {
  return presentationOptions(input);
}

/**
 * Preserve inference for the complete query options contract.
 * @param input - Project-authorized source request.
 * @returns Typed query options.
 * @throws {never} Requests only run when a consumer observes the options.
 */
function presentationOptions(input: VideoPresentationQueryInput): VideoPresentationQueryOptions {
  return queryOptions({
    queryKey: ['video-presentation', 1, input.projectId, input.canonicalURL] as const,
    enabled: input.active && input.projectId.length > 0 && input.canonicalURL.length > 0,
    retry: false,
    queryFn: async ({ signal }): Promise<VideoPresentationResponse> => {
      const answered = await apiGet<unknown>(`/projects/${input.projectId}/assets/video-presentation`, {
        params: { url: input.canonicalURL }, signal,
      });
      signal.throwIfAborted();
      return videoPresentationResponseSchema.parse(answered);
    },
  });
}

/**
 * Request a platform-funded repair of this exact registered source.
 * @param input - Current project and canonical registered identity.
 * @param requestId - Stable idempotency identity retained for this press.
 * @returns The read response after the repair was accepted (§3.5).
 * @throws {Error} When the server refuses, transport fails or the response is invalid.
 */
export async function repairVideoPresentation(input: VideoPresentationRepairInput, requestId: string): Promise<VideoPresentationResponse> {
  try {
    const answer = await apiPost<unknown>(`/projects/${input.projectId}/assets/video-presentation/repair`, {
      canonicalURL: input.canonicalURL, sourceFingerprint: input.sourceFingerprint,
    }, runOnceRequest(requestId));
    return videoPresentationResponseSchema.parse(answer);
  } catch (error) {
    toast.error(error instanceof ApiException && error.fromServer ? error.message : t('canvas.task.couldNotStart'));
    throw error;
  }
}
