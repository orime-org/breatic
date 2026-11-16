// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * In the region suite the services connect as the role migrate grants
 * outside the global region, so a query on a global table fails there
 * (inner#1955). Runs after the shared env setup; fixtures still read
 * `inject("DATABASE_URL")`, the owning role.
 */

import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    REGION_APP_DATABASE_URL: string;
    REGION_APP_YJS_DATABASE_URL: string;
  }
}

process.env.DATABASE_URL = inject("REGION_APP_DATABASE_URL");
process.env.YJS_DATABASE_URL = inject("REGION_APP_YJS_DATABASE_URL");
