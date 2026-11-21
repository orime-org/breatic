// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Timeline preview's read of each registered video through the presentation query Qp the canvas node reads
 * (inner#1306 frames-split design §7.8 surface list, §7.9 last paragraph, §7.14): a selected version plays through the
 * renderer the canvas uses, native and alpha-packed alike; with nothing selected the original plays for display, and the
 * candidate's failure, when it has one, is shown.
 */

import * as React from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { AlphaPackedManifest, VideoPresentationResponse } from '@breatic/shared';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import { alphaManifestQuery } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';

/** One registered video's presentation as the Timeline uses it. */
export interface TimelinePresentation {
  /** The selected version ready to render, with its verified manifest when alpha-packed; null while none is ready. */
  source: VideoPresentationSource | null;
  /** Whether a version is selected. */
  selected: boolean;
  /** The target candidate's failure while nothing is selected, or the selected version's manifest failure; else null. */
  failure: string | null;
}

/**
 * Reads Qp, and each selected alpha-packed version's manifest, for every registered video URL the preview shows.
 * @param projectId - The Project.
 * @param urls - The registered original URLs.
 * @returns Each URL's presentation; a URL whose read has not answered, or failed, is absent and plays its original.
 * @throws {never} Read failures stay in the query state.
 */
export function useTimelinePresentations(projectId: string, urls: readonly string[]): ReadonlyMap<string, TimelinePresentation> {
  // A stable combine keeps each result's identity while no read changed (TanStack Query `combine`).
  const combineReads = React.useCallback((results: Array<UseQueryResult<VideoPresentationResponse, Error>>): ReadonlyArray<VideoPresentationResponse | undefined> =>
    results.map((result) => result.data), []);
  const reads = useQueries({ queries: urls.map((url) => videoPresentationQuery({ projectId, canonicalURL: url, active: true })), combine: combineReads });
  const combineManifests = React.useCallback((results: Array<UseQueryResult<AlphaPackedManifest, Error>>): ReadonlyArray<{ data: AlphaPackedManifest | undefined; failed: boolean }> =>
    results.map((result) => ({ data: result.data, failed: result.isError })), []);
  const manifests = useQueries({ queries: reads.map((read) => alphaManifestQuery(read?.presentation ?? null, true)), combine: combineManifests });
  return React.useMemo(() => {
    const read = new Map<string, TimelinePresentation>();
    urls.forEach((url, index) => {
      const data = reads[index];
      // A read that failed is not a candidate failure: the original keeps playing for display (§7.8 detached × Attach).
      if (data === undefined) return;
      const version = data.presentation;
      if (version === null) { read.set(url, { source: null, selected: false, failure: data.preparation?.failure ?? null }); return; }
      const manifest = manifests[index];
      const base = { canonicalURL: data.sourceBinding.canonicalURL, sourceFingerprint: data.sourceBinding.contentHash, presentation: version };
      if (version.playback.kind === 'native') { read.set(url, { source: { ...base, manifest: null }, selected: true, failure: null }); return; }
      read.set(url, manifest?.data === undefined
        ? { source: null, selected: true, failure: manifest?.failed === true ? 'invalid-alpha-manifest' : null }
        : { source: { ...base, manifest: manifest.data }, selected: true, failure: null });
    });
    return read;
  }, [urls, reads, manifests]);
}
