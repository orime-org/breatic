// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { getLocale, TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1 } from '@breatic/shared';
import { orderedTimelineTracks } from '@web/data/yjs/timeline-order';

import { useTranslation } from '@web/i18n/use-translation';

/** One track and its display name. */
export interface TimelineTrackLabel { id: string; label: string }

/** Tracks bottom-up with their names (`visual` keeps its earlier name), and a name lookup for any track id. */
export interface TimelineTrackLabels { visual: TimelineTrackLabel[]; nameOf: (trackId: string) => string | null }

/**
 * Name the document's tracks bottom-up: the main track, then "Track N" where N is the track's 1-based position (the
 * first sub track is 2). Tracks hold any kind of clip (inner#1709).
 * @param document - The current Timeline.
 * @returns The bottom-up tracks and a lookup that returns null for a missing track.
 * @throws {never} Never.
 */
export function useTimelineTrackLabels(document: TimelineDocumentV1): TimelineTrackLabels {
  const t = useTranslation();
  // `t` keeps its identity across language changes, so the memo is keyed on the active locale.
  const locale = getLocale();
  return React.useMemo(() => {
    const visual = orderedTimelineTracks(document.tracks).map((track, index) => ({ id: track.id, label: track.id === TIMELINE_MAIN_TRACK_ID ? t('timeline.mainTrack') : t('timeline.track', { index: index + 1 }) }));
    const names = new Map(visual.map((track) => [track.id, track.label]));
    return { visual, nameOf: (trackId: string) => names.get(trackId) ?? null };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale stands in for the translations `t` returns.
  }, [document.tracks, t, locale]);
}
