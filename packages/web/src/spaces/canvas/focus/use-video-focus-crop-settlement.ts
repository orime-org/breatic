// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The canvas layer's side of a video focus crop (frames-split design §5.5 result feedback row, §7.18): for every waiting
 * card it decides the end at three moments, whether the panel is open or not — the panel node's `focusCropOutcomes` gains
 * the run_id, its `taskCounts` change (or the press is admitted) and the task list is read, or a done row's deadline passes.
 */

import * as React from 'react';
import { MAX_FOCUS_ENTRIES, type NodeTaskEntry } from '@breatic/shared';
import { canvasApi } from '@web/data/api/canvas';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import {
  endVideoFocusCrop, subscribeVideoFocusCropRuns, videoFocusCropRowOf, videoFocusCropRuns, videoFocusCropRunsRevision, videoFocusCropSettlement,
  type VideoFocusCropRead,
} from '@web/spaces/canvas/focus/run-focus-crop';

/** The panel node facts the settlement reads. */
interface PanelFacts { focusCropOutcomes?: Record<string, 'added' | 'refused'>; taskCounts?: unknown }

/**
 * Settles this Space's waiting video focus crops.
 * @param projectId - The Project.
 * @param spaceId - The canvas Space.
 * @param nodes - The canvas nodes, whose data carries `focusCropOutcomes` and `taskCounts` (node-view `contentCommon`).
 * @throws {never} A failed task-list read leaves the cards waiting for the next moment.
 */
export function useVideoFocusCropSettlement(projectId: string, spaceId: string, nodes: readonly { id: string; data: unknown }[]): void {
  const t = useTranslation();
  const revision = React.useSyncExternalStore(subscribeVideoFocusCropRuns, videoFocusCropRunsRevision);
  // The last row read per run, so a marker reached without a counts change is judged against it.
  const rows = React.useRef(new Map<string, VideoFocusCropRead['row']>());
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seenCounts = React.useRef(new Map<string, string>());
  const readNodes = React.useRef(nodes);
  readNodes.current = nodes;

  /**
   * Applies one settlement: removes the card and says why when the table says so.
   * @param runId - The crop.
   * @param read - What was read.
   * @returns Whether the card stays.
   */
  const settle = React.useCallback((runId: string, read: VideoFocusCropRead): boolean => {
    const outcome = videoFocusCropSettlement(read);
    const timer = timers.current.get(runId);
    if (timer !== undefined) { clearTimeout(timer); timers.current.delete(runId); }
    if (outcome.placeholder === 'keep') {
      if (outcome.recheckAt !== null) {
        timers.current.set(runId, setTimeout(() => {
          timers.current.delete(runId);
          const data = readNodes.current.find((node) => node.id === videoFocusCropRuns().get(runId)?.panelNodeId)?.data as PanelFacts | undefined;
          settle(runId, { row: rows.current.get(runId) ?? 'cleared', outcome: data?.focusCropOutcomes?.[runId], now: Date.now() });
        }, Math.max(0, outcome.recheckAt - Date.now())));
      }
      return true;
    }
    endVideoFocusCrop(spaceId, runId);
    rows.current.delete(runId);
    if (outcome.toast === 'referencePoolFull') toast.warning(t('canvas.generatePanel.referencePoolFull', { cap: MAX_FOCUS_ENTRIES }));
    else if (outcome.toast === 'error') {
      const row = read.row;
      toast.error(t(typeof row === 'object' && row.status === 'expired' ? 'canvas.generatePanel.focusCropExpired' : 'canvas.generatePanel.focusExportFailed'));
    }
    return false;
  }, [spaceId, t]);

  React.useEffect(() => {
    void revision;
    const runs = [...videoFocusCropRuns()].filter(([, run]) => run.spaceId === spaceId);
    const toRead = new Set<string>();
    for (const [runId, run] of runs) {
      const data = nodes.find((node) => node.id === run.panelNodeId)?.data as PanelFacts | undefined;
      if (!run.admitted) continue;
      const outcome = data?.focusCropOutcomes?.[runId];
      // The marker decides on its own; the task list is not read (§7.18).
      if (outcome !== undefined) { settle(runId, { row: rows.current.get(runId) ?? 'cleared', outcome, now: Date.now() }); continue; }
      const counts = JSON.stringify(data?.taskCounts ?? null);
      if (seenCounts.current.get(runId) !== counts) { seenCounts.current.set(runId, counts); toRead.add(run.panelNodeId); }
    }
    for (const panelNodeId of toRead) {
      void canvasApi.listNodeTasks(panelNodeId, projectId, spaceId).then((tasks: NodeTaskEntry[]) => {
        for (const [runId, run] of videoFocusCropRuns()) {
          if (run.panelNodeId !== panelNodeId || !run.admitted) continue;
          const task = tasks.find((entry) => entry.taskId === runId);
          const row = videoFocusCropRowOf(task);
          rows.current.set(runId, row);
          const data = readNodes.current.find((node) => node.id === panelNodeId)?.data as PanelFacts | undefined;
          settle(runId, { row, outcome: data?.focusCropOutcomes?.[runId], now: Date.now() });
        }
      }, () => undefined);
    }
  }, [revision, nodes, projectId, spaceId, settle]);

  React.useEffect(() => {
    const owned = timers.current;
    return () => { for (const timer of owned.values()) clearTimeout(timer); owned.clear(); };
  }, []);
}
