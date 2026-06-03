// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet } from '@web/data/api/request';

export interface ModelDef {
  id: string;
  provider: string;
  modality: 'text' | 'image' | 'audio' | 'video' | 'tts' | '3d' | 'understand';
  cost: number;
  capabilities?: string[];
}

export const modelsApi = {
  list() {
    return apiGet<{ models: ModelDef[] }>('/models');
  },
};
