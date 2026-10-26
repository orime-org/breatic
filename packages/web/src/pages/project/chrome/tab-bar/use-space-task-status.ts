// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SpaceType } from '@breatic/shared';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { hasSpaceTaskRequests, useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import { useDocProvider } from '@web/data/yjs/collab-socket';
import { docName } from '@web/data/yjs/manager';
import { useCanvasTaskState } from '@web/data/yjs/use-canvas-task-state';
import { useSpacePeerTaskStatus } from '@web/spaces/canvas/use-space-peer-task-status';

/**
 * Combine the existing task facts this browser knows for one Space.
 * @param projectId - Owning Project.
 * @param spaceId - Observed Space.
 * @param type - Space type.
 * @returns Whether an existing source reports ongoing work.
 * @throws {never} Never.
 */
export function useSpaceTaskStatus(projectId: string, spaceId: string, type: SpaceType): boolean {
  const canvas = type === 'canvas';
  const operations = useSpaceOperationsStore((state) => state.hasOperations(spaceId));
  const waiting = useUploadMarksStore((state) => canvas
    && Object.values(state.marks[spaceId] ?? {}).some((mark) => mark.state === 'waiting'));
  const requests = useTaskActionsInFlight((state) => canvas && hasSpaceTaskRequests(state, projectId, spaceId));
  const provider = useDocProvider(canvas ? docName.canvasSpace(projectId, spaceId) : null);
  const tasks = useCanvasTaskState(projectId, spaceId, canvas, provider?.document);
  const peers = useSpacePeerTaskStatus(provider?.awareness ?? null, tasks.contentNodeIds);
  return operations || waiting || requests || tasks.running || peers;
}
