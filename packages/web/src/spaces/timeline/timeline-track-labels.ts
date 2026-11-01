// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { getLocale, orderedTimelineTracks, TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1 } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';

/** One visual track and its display name. */
export interface TimelineTrackLabel { id: string; label: string }

/** Visual tracks bottom-up with their names, and a name lookup for any track id. */
export interface TimelineTrackLabels { visual: TimelineTrackLabel[]; nameOf: (trackId: string) => string | null }

/**
 * Name the document's visual tracks: the main track, then "Track N" counted bottom-up from 1.
 * @param document - The current Timeline.
 * @returns The bottom-up visual tracks and a lookup that returns null for a missing track.
 * @throws {never} Never.
 */
export function useTimelineTrackLabels(document: TimelineDocumentV1): TimelineTrackLabels {
  const t = useTranslation();
  // `t` keeps its identity across language changes, so the memo is keyed on the active locale.
  const locale = getLocale();
  return React.useMemo(() => {
    const visual = orderedTimelineTracks(document.tracks).filter((track) => track.kind === 'visual')
      .map((track, index) => ({ id: track.id, label: track.id === TIMELINE_MAIN_TRACK_ID ? t('timeline.mainTrack') : t('timeline.track', { index: index + 1 }) }));
    const names = new Map(visual.map((track) => [track.id, track.label]));
    return { visual, nameOf: (trackId: string) => names.get(trackId) ?? null };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale stands in for the translations `t` returns.
  }, [document.tracks, t, locale]);
}
