/**
 * Models API — AIGC model catalog.
 */

import { request } from '@/utils/request';

/** Model tier for frontend display filtering. */
export type ModelTier = 'recommended' | 'optional' | 'internal';

/** Single parameter descriptor for dynamic form rendering. */
export interface ParamDescriptor {
  description: string;
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  type?: string;
  max_items?: number;
  default: unknown;
}

/** Provider info for a model. */
export interface ModelProvider {
  name: string;
  model_id: string;
  priority: number;
  available: boolean;
}

/** Single model entry from the catalog. */
export interface ModelEntry {
  name: string;
  display_name: string;
  modality: string;
  mode: string | string[];
  description: string;
  guide: string;
  tier: ModelTier;
  cost_per_call: number;
  generation_time: number;
  params: Record<string, ParamDescriptor>;
  providers: ModelProvider[];
}

/** Full model catalog grouped by modality. */
export interface ModelCatalog {
  image: ModelEntry[];
  video: ModelEntry[];
  audio: ModelEntry[];
  tts: ModelEntry[];
  three_d: ModelEntry[];
  understand: ModelEntry[];
  total: number;
}

/**
 * Get the full model catalog.
 *
 * Call once at startup, cache with React Query (staleTime: 5min).
 * Models without configured API keys are automatically excluded.
 */
export const getAll = () =>
  request<{ data: ModelCatalog }>({
    url: '/api/v1/models',
    method: 'get',
  });
