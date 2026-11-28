// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The container addresses `containers.ts` hands to every test file.
 *
 * Vitest types `inject()` from this interface by declaration merging, so it
 * has to be part of each package's tsc program. Each package's
 * `vitest.integration.config.ts` (which its tsconfig includes) brings it in
 * with `import type {} from "@breatic/integration-tests/provided-context"`.
 */

export {};

declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
    YJS_DATABASE_URL: string;
    REDIS_URL: string;
    REDIS_QUEUE_URL: string;
    REDIS_STREAM_URL: string;
    REDIS_COLLAB_URL: string;
    /** collab's own login, used only by the code paths collab runs normally. */
    COLLAB_DATABASE_URL: string;
    /** A second login holding the same role, for tests that write out of scope on purpose. */
    COLLAB_PROBE_DATABASE_URL: string;
  }
}
