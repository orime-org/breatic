// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiPost } from '@web/data/api/request';
import type { CanvasTask } from '@web/data/api/canvas';

interface BaseToolRequest {
  projectId: string;
  spaceId: string;
  sourceNodeId: string;
  toolId: string;
  params: Record<string, unknown>;
}

export const miniToolsApi = {
  image(body: BaseToolRequest) {
    return apiPost<CanvasTask>('/mini-tools/image', body);
  },
  audio(body: BaseToolRequest) {
    return apiPost<CanvasTask>('/mini-tools/audio', body);
  },
  video(body: BaseToolRequest) {
    return apiPost<CanvasTask>('/mini-tools/video', body);
  },
};
