// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one description of "fetch the model catalog" (#1966).
 *
 * Four places ask for it: the readiness gate, the two panel containers, and the
 * prefetch that warms it when a canvas space mounts. They were four hand-copied
 * literals, and the prefetch made that dangerous rather than merely repetitive:
 * a warm-up only warms the cache the gate reads if the two agree on the key
 * CHARACTER FOR CHARACTER, and a disagreement is invisible — no type error, no
 * failing test, just a request the gate makes anyway and a wait the prefetch was
 * supposed to remove.
 *
 * The `queryFn` travels with the key for the same reason: two callers keyed the
 * same but fetching differently would populate one entry with whichever answer
 * arrived last.
 */

import { modelsApi } from '@web/data/api';
import type { ModelCatalog } from '@breatic/shared';

/**
 * The cache key every model-catalog reader and the prefetch share.
 *
 * Module-private: handing it out separately is how the prefetch and the gate
 * could come to key the same cache differently, which is the exact failure
 * this module exists to prevent. Callers take {@link modelCatalogQuery}.
 */
const MODEL_CATALOG_KEY = ['models'] as const;

/** What `useQuery` and `prefetchQuery` both need to reach the catalog. */
export interface ModelCatalogQuery {
  /** The shared cache key. */
  queryKey: typeof MODEL_CATALOG_KEY;
  /** The shared fetcher. */
  queryFn: () => Promise<ModelCatalog>;
}

/**
 * Query options for the model catalog, passed to `useQuery` / `prefetchQuery`.
 * @returns The key and fetcher, as one object so the two cannot drift apart.
 */
export function modelCatalogQuery(): ModelCatalogQuery {
  return {
    queryKey: MODEL_CATALOG_KEY,
    queryFn: () => modelsApi.list(),
  };
}
