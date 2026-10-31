// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useNodeId } from '@xyflow/react';

import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useUploadMarksStore, type UploadMark } from '@web/stores/upload-marks';

/**
 * The uploader's own mark on the node this is rendered inside (inner#1303
 * §6.7), read for the canvas's Space.
 * @returns The mark, or undefined outside a node or when the node has none.
 */
export function useUploadMark(): UploadMark | undefined {
  const nodeId = useNodeId();
  const { spaceId } = useCanvasContext();
  return useUploadMarksStore((s) => (nodeId === null ? undefined : s.marks[spaceId]?.[nodeId]));
}
