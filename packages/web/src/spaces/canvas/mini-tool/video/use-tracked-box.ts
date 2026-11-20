// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The box following a tracked object on the presented frame (inner#1306 execution design §10.3 overlay paragraph), read from
 * the completed tracking analysis's RLE: a JSON array with each range frame's COCO counts, null where a frame has no mask.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { httpRequest } from '@breatic/shared';
import type { MiniToolAnalysisRecord, VideoPlanGrid } from '@breatic/shared/mini-tools';
import { frameIndexOfMediaTime } from '@web/spaces/canvas/video-presentation/frame-grid-time';
import { trackedBox, type TrackedBox } from '@web/spaces/canvas/mini-tool/video/tracked-box';

const countsSchema = z.array(z.string().nullable());

/**
 * Read one stored RLE.
 * @param url - Its address.
 * @param signal - Aborts the read.
 * @returns Each frame's counts.
 * @throws {Error} When the read fails or the file is not an RLE.
 */
async function fetchCounts(url: string, signal: AbortSignal): Promise<(string | null)[]> {
  const response = await httpRequest(url, { credentials: 'omit' }, { replaySafe: true, signal });
  if (!response.ok) throw new Error(`The tracked RLE answered ${response.status}`);
  return countsSchema.parse(await response.json());
}

/**
 * The tracked box on the presented frame.
 * @param record - The tracking analysis made for the current selection, if any.
 * @param grid - The selected version's grid.
 * @param range - The erase range in grid frames.
 * @param presentedTime - The presented media time, null while unknown.
 * @returns The box, or null when nothing is tracked on that frame.
 * @throws {never} Never.
 */
export function useTrackedBox(record: MiniToolAnalysisRecord | undefined, grid: VideoPlanGrid | null, range: { start: number; end: number } | null, presentedTime: number | null): TrackedBox | null {
  const result = record?.status === 'completed' && record.result?.kind === 'tracked_mask' ? record.result : null;
  const url = result?.artifactRefs[0]?.canonicalURL ?? null;
  const counts = useQuery({ queryKey: ['tracked-mask-rle', url], queryFn: ({ signal }) => fetchCounts(url!, signal), enabled: url !== null, staleTime: Infinity }).data;
  return React.useMemo(() => {
    if (result === null || counts === undefined || grid === null || range === null || presentedTime === null) return null;
    const size = { width: result.width, height: result.height };
    const masks = counts.map((frame) => frame === null ? null : { size: [size.height, size.width] as const, counts: frame });
    try {
      return trackedBox(masks, { startFrame: range.start, frameCount: result.frameCount }, frameIndexOfMediaTime(presentedTime, grid), size);
    } catch {
      // A mask that does not decode at the result's size draws no box; the selection stays visible.
      return null;
    }
  }, [result, counts, grid, range, presentedTime]);
}
