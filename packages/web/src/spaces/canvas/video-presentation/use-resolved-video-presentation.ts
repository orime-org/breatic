// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { DEFAULT_TIMEOUT_MS, readAlphaPackedManifest, type AlphaPackedManifest, type VideoPresentationResponse, type VideoPresentationVersion } from '@breatic/shared';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';

/** Project-authorized source facts consumed through the existing account query client. */
export interface ResolvedVideoPresentation {
  query: UseQueryResult<VideoPresentationResponse, Error>;
  source: VideoPresentationSource | null;
  failure: string | null;
}

/**
 * Describe the read of an alpha-packed version's manifest (design §3.5 alpha manifest row): the object its receipt
 * measures, held to the version. The receipt is immutable, so the answer never goes stale.
 * @param version - The selected version, or null.
 * @param active - Whether the reader is displayed.
 * @returns Options that read nothing unless the version is alpha-packed.
 * @throws {never} Constructing options starts no request.
 */
function manifestQuery(version: VideoPresentationVersion | null, active: boolean): UseQueryOptions<AlphaPackedManifest, Error, AlphaPackedManifest, readonly unknown[]> {
  const alpha = version?.playback.kind === 'alpha-packed' ? version : null;
  return {
    queryKey: ['video-presentation-manifest', 1, alpha?.versionId ?? '', alpha?.playback.kind === 'alpha-packed' ? alpha.playback.manifest : null],
    enabled: active && alpha !== null,
    retry: false,
    staleTime: Infinity,
    queryFn: ({ signal }): Promise<AlphaPackedManifest> => {
      if (alpha === null) return Promise.reject(new Error('No alpha-packed version to read'));
      return readAlphaPackedManifest(alpha, { deadlineAt: Date.now() + DEFAULT_TIMEOUT_MS, signal });
    },
  };
}

/**
 * Resolves node and timeline sources with one interpretation of the selected version (design §7.8).
 * @param projectId - The current authorized Project.
 * @param canonicalURL - The registered original video URL.
 * @param active - Whether this decoder is currently displayed.
 * @returns Ready owned source data or an explicit pending/failed result.
 * @throws {never} Query failures stay in the returned query state.
 */
export function useResolvedVideoPresentation(projectId: string, canonicalURL: string, active: boolean): ResolvedVideoPresentation {
  const query = useQuery(videoPresentationQuery({ projectId, canonicalURL, active }));
  const selected = query.data?.presentation ?? null;
  const manifest = useQuery(manifestQuery(selected, active));
  // Keyed on the facts the source is built from, so another change in the response keeps the renderer (§7.8 Replace).
  const canonical = query.data?.sourceBinding.canonicalURL;
  const fingerprint = query.data?.sourceBinding.contentHash;
  const source = React.useMemo<VideoPresentationSource | null>(() => {
    if (canonical === undefined || fingerprint === undefined || selected === null) return null;
    const base = { canonicalURL: canonical, sourceFingerprint: fingerprint, presentation: selected };
    if (selected.playback.kind === 'native') return { ...base, manifest: null };
    return manifest.data === undefined ? null : { ...base, manifest: manifest.data };
  }, [canonical, fingerprint, selected, manifest.data]);
  // Nothing selected and the target candidate failed (§7.12 step 2), or the manifest is not this version's.
  const failure = query.isError ? 'presentation-query-failed' : manifest.isError ? 'invalid-alpha-manifest'
    : query.data?.presentation === null ? query.data.preparation?.failure ?? null : null;
  return { query, source, failure };
}
