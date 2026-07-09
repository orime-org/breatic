// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { sanitizeModelCatalog, type ModelCatalog } from '@breatic/shared';

import { apiGet } from '@web/data/api/request';

export const modelsApi = {
  /**
   * Fetch the full AIGC model catalog, grouped by modality. The backend
   * filters by configured API keys; the frontend caches this at startup and
   * reads it to render the Generate panel's model picker + param form.
   *
   * Trust boundary: the catalog is untrusted external input, so the whole
   * response is run through {@link sanitizeModelCatalog} once here — a
   * malformed field / entry / bucket is coerced or dropped rather than allowed
   * to poison the panel. Downstream code consumes the sanitized value and can
   * trust the types instead of re-guarding every field.
   * @returns The sanitized model catalog (already unwrapped from `{ data }`).
   * @throws {import('@web/data/api/types').ApiException} When the request fails.
   */
  async list(): Promise<ModelCatalog> {
    const raw = await apiGet<unknown>('/models');
    return sanitizeModelCatalog(raw);
  },
};
