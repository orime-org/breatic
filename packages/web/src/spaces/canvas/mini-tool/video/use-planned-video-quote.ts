// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The footer quote of a planned video run (inner#1306 §97 D26-1): the server prices the planned request the Run would send
 * with the admission's own computation, so the panel prices nothing itself. The output node ids are chosen once per panel,
 * one per planned output (a split names one per segment), so the Run can name the same ones.
 */
import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { newId } from '@breatic/shared';
import { canonicalMiniToolValue, miniToolChargeTo, type MiniToolPlannedRequest, type VideoToolDraft, type VideoToolId } from '@breatic/shared/mini-tools';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { useDebounce } from '@web/lib/use-debounce';
import { buildPlannedVideoRequest, plannedVideoRecipes, type PlannedVideoFacts } from '@web/spaces/canvas/mini-tool/start-planned-video-run';

/**
 * Quote the current draft's planned run.
 * @param tool - The tool.
 * @param draft - The current draft, or null.
 * @param facts - The panel's request facts, or null while the selected input is not known.
 * @param debounceMs - How long the request holds still before it is quoted (config `quote_debounce_ms`).
 * @returns The quoted credits as footer text, and the output node ids the quote named; no text while it has not answered.
 * @throws {never} Never.
 */
export function usePlannedVideoQuote(tool: VideoToolId, draft: VideoToolDraft | null, facts: PlannedVideoFacts | null, debounceMs: number): { text?: string; outputNodeIds: readonly string[] } {
  const count = React.useMemo((): number => {
    if (draft === null || facts === null) return 1;
    try {
      return plannedVideoRecipes(tool, draft, facts.grid).length;
    } catch {
      return 1;
    }
  }, [tool, draft, facts]);
  // Ids already named stay named as the count changes, so a quoted node keeps its id.
  const pool = React.useRef<string[]>([]);
  const outputNodeIds = React.useMemo((): readonly string[] => {
    while (pool.current.length < count) pool.current.push(newId());
    return pool.current.slice(0, count);
  }, [count]);
  const body = React.useMemo((): MiniToolPlannedRequest | null => {
    if (draft === null || facts === null) return null;
    try {
      return buildPlannedVideoRequest(tool, draft, facts, outputNodeIds);
    } catch {
      // An incomplete draft is quoted once it is complete; Run refuses it with its own reason meanwhile.
      return null;
    }
  }, [tool, draft, facts, outputNodeIds]);
  // The run id is new per build; the quote follows everything else the request says, once it has held still (the route is
  // rate limited), and the last price stays on screen meanwhile.
  const pending = React.useMemo(() => body === null ? null : { key: canonicalMiniToolValue({ ...body, run_id: null }), body }, [body]);
  const settled = useDebounce(pending, debounceMs);
  const quote = useQuery({
    queryKey: ['mini-tool-quote', settled?.key ?? null],
    queryFn: () => miniToolsApi.quotePlannedVideoRun(settled!.body),
    // A platform-funded tool (frame extraction) costs the user nothing, so it is never quoted (frames-split §5.5).
    enabled: settled !== null && miniToolChargeTo(tool) !== 'platform',
    placeholderData: keepPreviousData,
    retry: false,
  });
  return { ...(quote.data === undefined || body === null ? {} : { text: formatCreditAmount(quote.data.credits) }), outputNodeIds };
}
