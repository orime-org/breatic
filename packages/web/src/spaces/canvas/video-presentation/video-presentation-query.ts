// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { queryOptions, type UseQueryOptions } from '@tanstack/react-query';
import { videoPresentationResponseSchema, type VideoPresentationResponse } from '@breatic/shared';
import { apiGet } from '@web/data/api/request';

/** Canonical source query inputs; the existing account-scoped client owns the cache. */
export interface VideoPresentationQueryInput { projectId: string; canonicalURL: string; active: boolean }
/** The existing query cache stores only source facts, never a media element. */
export type VideoPresentationQueryOptions = UseQueryOptions<VideoPresentationResponse, Error, VideoPresentationResponse,
  readonly ['video-presentation', 1, string, string]>;

/**
 * Describe one authorized canonical source query without creating another cache.
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
    refetchInterval: (query): number | false => {
      const data = query.state.data;
      return data?.preparation?.status === 'accepted' || data?.preparation?.status === 'running' ? data.pollAfterMs ?? false : false;
    },
  });
}
