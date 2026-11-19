// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tracking cost beside "Track selection" (canvas design §4 erase row): before tracking, the server's quote of the
 * tracking the press would start, anchored on the presented frame as the press anchors it; once the current selection's
 * tracking is billed, what it used.
 */
import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { newId } from '@breatic/shared';
import { canonicalMiniToolValue, planVideoFrames, type MiniToolAnalysisRecord, type MiniToolAnalysisRequest, type MiniToolPresentationRef, type VideoPresentationTable, type VideoToolDraftById } from '@breatic/shared/mini-tools';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { useDebounce } from '@web/lib/use-debounce';

/** Where the tracking would run and on what. */
export interface TrackingCostFacts {
  projectId: string;
  spaceId: string;
  nodeId: string;
  /** The erase draft, null for any other tool. */
  draft: VideoToolDraftById['video.erase'] | null;
  frameTable: VideoPresentationTable | null;
  presentationRef: MiniToolPresentationRef | undefined;
  presentedTime: number | null;
  /** The completed tracking of the current selection, if any. */
  tracking: MiniToolAnalysisRecord | undefined;
  debounceMs: number;
}

/**
 * The estimate before tracking and the actual use after it.
 * @param facts - The press's facts.
 * @returns The texts the controls show.
 * @throws {never} Never.
 */
export function useTrackingCost(facts: TrackingCostFacts): { estimate?: string; actual?: string } {
  const { projectId, spaceId, nodeId, draft, frameTable, presentationRef, tracking, presentedTime: time } = facts;
  const [runId] = React.useState(newId);
  const body = React.useMemo((): MiniToolAnalysisRequest | null => {
    if (draft === null || frameTable === null || presentationRef === undefined || time === null) return null;
    const { range, region, trackingPrompt } = draft.params;
    if (region.box === null && region.points.length === 0) return null;
    const frame = planVideoFrames(frameTable, { mode: 'current', currentTime: time })[0];
    if (frame === undefined) return null;
    return { analysisRunId: runId, projectId, spaceId, hostNodeId: nodeId, draftId: draft.draftId, revision: draft.revision, source: draft.source, presentationRef,
      kind: 'tracked_mask', params: { range, anchor: { frameIndex: frame.frameIndex, pts: frame.pts }, region, trackingPrompt } };
  }, [draft, frameTable, presentationRef, time, runId, projectId, spaceId, nodeId]);
  // The run id is new per panel; the quote follows everything else the request says, once it has held still (the route is
  // rate limited), and the last estimate stays on screen meanwhile.
  const pending = React.useMemo(() => body === null ? null : { key: canonicalMiniToolValue({ ...body, analysisRunId: null }), body }, [body]);
  const settled = useDebounce(pending, facts.debounceMs);
  const quote = useQuery({ queryKey: ['mini-tool-analysis-quote', settled?.key ?? null], queryFn: () => miniToolAnalysesApi.quote(settled!.body),
    enabled: settled !== null && tracking === undefined, placeholderData: keepPreviousData, retry: false });
  const used = tracking?.usage.flatMap((entry) => typeof entry.credits === 'number' ? [entry.credits] : []) ?? [];
  return {
    // A tracked selection shows no estimate; its use appears once its charge commits.
    ...(quote.data === undefined || body === null || tracking !== undefined ? {} : { estimate: formatCreditAmount(quote.data.credits) }),
    ...(used.length === 0 ? {} : { actual: formatCreditAmount(used.reduce((sum, credits) => sum + credits, 0)) }),
  };
}
