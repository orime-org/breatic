// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolAnalysisRecord, MiniToolPlannedRequest, VideoToolDraft, VideoToolId } from '@breatic/shared/mini-tools';
import type { MiniToolPlannedRunAnswer } from '@web/data/api/mini-tools';
import type { MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import type { RunOnceOutcome } from '@web/stores/task-actions-in-flight';

/** One press's existing Canvas capabilities and complete typed video snapshot. */
export interface PlannedVideoRun extends Pick<MiniToolRun, 'projectId' | 'spaceId' | 'userId' | 'source' | 'sourceExists' | 'stillOpen' | 'onBuilt'> {
  toolId: VideoToolId;
  draft: VideoToolDraft;
  analyses: readonly MiniToolAnalysisRecord[];
  canWrite: () => boolean;
}

/**
 * Prepares the frozen public request and creates its frontend-owned graph.
 * @param _run - The press snapshot and current write capability.
 * @returns Its body, or no request when preparation cannot proceed.
 * @throws {Error} Until planned preparation is implemented.
 */
export function preparePlannedVideoRun(_run: PlannedVideoRun): Promise<MiniToolPlannedRequest | null> {
  return Promise.reject(new Error('Planned video preparation is not implemented'));
}

/**
 * Drives a planned press through the existing run-once lifecycle.
 * @param _run - The press snapshot and existing Canvas capabilities.
 * @returns The existing press outcome.
 * @throws {Error} Until planned execution is implemented.
 */
export function startPlannedVideoRun(_run: PlannedVideoRun): Promise<RunOnceOutcome<MiniToolPlannedRunAnswer>> {
  return Promise.reject(new Error('Planned video execution is not implemented'));
}
