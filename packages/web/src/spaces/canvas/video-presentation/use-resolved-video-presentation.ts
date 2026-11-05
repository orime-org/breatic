// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
    const selected = data?.presentation;
    // ponytail: an alpha-packed version also needs its manifest object read; until that read exists only native versions play.
    if (data === undefined || !selected || selected.playback.kind !== 'native') return null;
    const { display, sourceFingerprint } = selected;
    return {
      canonicalURL: data.sourceBinding.canonicalURL, sourceFingerprint, playbackURL: selected.playback.carrier.url,
      presentation: { schemaVersion: 1, sourceFingerprint, state: 'native',
        original: { width: display.width, height: display.height, duration: Number(display.duration.numerator) / Number(display.duration.denominator) } },
    };
  }, [query.data]);
  // Nothing selected and the target candidate failed (§7.12 step 2): its code is the failure.
  const failure = query.isError ? 'presentation-query-failed' : query.data?.presentation === null ? query.data.preparation?.failure ?? null : null;
  return { query, source, failure };
}
