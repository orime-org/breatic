// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The footer quote of a planned video run (inner#1306 §97 D26-1): the server prices the planned request the Run would send
 * with the admission's own computation, so the panel prices nothing itself. The output node ids are chosen once per panel,
 * at the first quote, so the Run can name the same ones.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { newId } from '@breatic/shared';
import { canonicalMiniToolValue, type MiniToolPlannedRequest, type VideoToolDraft, type VideoToolId } from '@breatic/shared/mini-tools';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { buildPlannedVideoRequest, type PlannedVideoFacts } from '@web/spaces/canvas/mini-tool/start-planned-video-run';

/**
 * Quote the current draft's planned run.
 * @param tool - The tool.
 * @param draft - The current draft, or null.
 * @param facts - The panel's request facts, or null while the selected input is not known.
 * @returns The quoted credits as footer text, and the output node ids the quote named; no text while it has not answered.
 * @throws {never} Never.
 */
export function usePlannedVideoQuote(tool: VideoToolId, draft: VideoToolDraft | null, facts: PlannedVideoFacts | null): { text?: string; outputNodeIds: readonly string[] } {
  const [outputNodeIds] = React.useState<readonly string[]>(() => [newId()]);
  const body = React.useMemo((): MiniToolPlannedRequest | null => {
    if (draft === null || facts === null) return null;
    try {
      return buildPlannedVideoRequest(tool, draft, facts, outputNodeIds);
    } catch {
      // An incomplete draft is quoted once it is complete; Run refuses it with its own reason meanwhile.
      return null;
    }
  }, [tool, draft, facts, outputNodeIds]);
  // The run id is new per build; the quote follows everything else the request says.
  const key = body === null ? null : canonicalMiniToolValue({ ...body, run_id: null });
  const quote = useQuery({
    queryKey: ['mini-tool-quote', key],
    queryFn: () => miniToolsApi.quotePlannedVideoRun(body!),
    enabled: body !== null,
    retry: false,
  });
  return { ...(quote.data === undefined || body === null ? {} : { text: formatCreditAmount(quote.data.credits) }), outputNodeIds };
}
