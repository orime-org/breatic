// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1, type TimelineTrack } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';

/** One visual track and its display name. */
export interface TimelineTrackLabel { id: string; order: number; label: string }

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
  // Names are rebuilt on every render: `t` keeps its identity when the language changes, so a memo keyed on
  // it would keep the previous language's names.
  const visual = Object.values(document.tracks).filter((track: TimelineTrack) => track.kind === 'visual')
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    .map((track, index) => ({ id: track.id, order: track.order, label: track.id === TIMELINE_MAIN_TRACK_ID ? t('timeline.mainTrack') : t('timeline.track', { index: index + 1 }) }));
  const names = new Map(visual.map((track) => [track.id, track.label]));
  return { visual, nameOf: (trackId: string) => names.get(trackId) ?? null };
}
