// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Timeline preview's read of each registered video through the presentation query Qp the canvas node reads
 * (inner#1306 frames-split design §7.8 surface list, §7.9 last paragraph): a selected version plays its playback file;
 * with nothing selected the original plays for display, and the candidate's failure, when it has one, is shown.
 */

import * as React from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { VideoPresentationResponse } from '@breatic/shared';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';

/** One registered video's presentation as the Timeline uses it. */
export interface TimelinePresentation {
  /**
   * The selected version's playback file, or null while none is selected. An alpha-packed version keeps the original:
   * a Timeline layer is a plain `<video>`, which would show the packed carrier's colour and alpha halves side by side.
   */
  playbackUrl: string | null;
  /** Whether a version is selected. */
  selected: boolean;
  /** The target candidate's failure while nothing is selected, or null. */
  failure: string | null;
}

/**
 * Reads Qp for every registered video URL the preview shows.
 * @param projectId - The Project.
 * @param urls - The registered original URLs.
 * @returns Each URL's presentation; a URL whose read has not answered, or failed, is absent and plays its original.
 * @throws {never} Read failures stay in the query state.
 */
export function useTimelinePresentations(projectId: string, urls: readonly string[]): ReadonlyMap<string, TimelinePresentation> {
  // A stable combine keeps the map's identity while no read changed (TanStack Query `combine`).
  const combine = React.useCallback((results: Array<UseQueryResult<VideoPresentationResponse, Error>>): ReadonlyMap<string, TimelinePresentation> => {
    const read = new Map<string, TimelinePresentation>();
    results.forEach((result, index) => {
      const url = urls[index]!;
      // A read that failed is not a candidate failure: the original keeps playing for display (§7.8 detached × Attach).
      if (result.data !== undefined) {
        const version = result.data.presentation;
        read.set(url, version === null
          ? { playbackUrl: null, selected: false, failure: result.data.preparation?.failure ?? null }
          : { playbackUrl: version.playback.kind === 'native' ? version.playback.carrier.url : null, selected: true, failure: null });
      }
    });
    return read;
  }, [urls]);
  return useQueries({ queries: urls.map((url) => videoPresentationQuery({ projectId, canonicalURL: url, active: true })), combine });
}
