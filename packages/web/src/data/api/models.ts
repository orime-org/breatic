import { apiGet } from '@/data/api/request';

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
