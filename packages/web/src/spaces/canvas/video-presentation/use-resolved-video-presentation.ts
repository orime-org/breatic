// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { VideoPresentationResponse } from '@breatic/shared';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';

/** Project-authorized source facts consumed through the existing account query client. */
export interface ResolvedVideoPresentation {
  query: UseQueryResult<VideoPresentationResponse, Error>;
  source: VideoPresentationSource | null;
  failure: string | null;
}

/**
 * Resolves node and timeline sources with one interpretation of the owned descriptor.
 * @param projectId - The current authorized Project.
 * @param canonicalURL - The registered original video URL.
 * @param active - Whether this decoder is currently displayed.
 * @returns Ready owned source data or an explicit pending/failed result.
 * @throws {never} Query failures stay in the returned query state.
 */
export function useResolvedVideoPresentation(projectId: string, canonicalURL: string, active: boolean): ResolvedVideoPresentation {
  const query = useQuery(videoPresentationQuery({ projectId, canonicalURL, active }));
  const source = React.useMemo<VideoPresentationSource | null>(() => {
    const data = query.data;
    if (!data?.presentation || (data.presentation.state !== 'native' && data.presentation.state !== 'alpha_ready')) return null;
    return { canonicalURL: data.sourceBinding.canonicalURL, sourceFingerprint: data.sourceBinding.contentHash, presentation: data.presentation, ...(data.manifest === undefined ? {} : { manifest: data.manifest }) };
  }, [query.data]);
  const failure = query.isError ? 'presentation-query-failed' : query.data?.preparation?.status === 'failed' ? query.data.preparation.error ?? 'preparation-failed' : query.data?.presentation?.state === 'failed' ? query.data.presentation.error ?? 'presentation-failed' : null;
  return { query, source, failure };
}
