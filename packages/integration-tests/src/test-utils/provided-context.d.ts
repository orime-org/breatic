// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  }
}
