// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Types for brand.mjs, which the build scripts and tsup.config.ts share. */

/** A loaded brand with every derived name. */
export interface Brand {
  id: string;
  productName: string;
  appId: string;
  scheme: string;
  serverUrl: string;
  icon: string;
  logo: string;
  poweredBy: boolean;
  packageName: string;
  executableName: string;
  newWindowExec: string;
  appImageEntryName: string;
  artifactName: string;
}

/** The official brand's directory. */
export const OFFICIAL_BRAND_DIR: string;

/** Read and check a brand directory. */
export function loadBrand(dir: string, env?: Record<string, string | undefined>): Brand;

/** The brand this build is for: BREATIC_BRAND_DIR when set, else the official one. */
export function currentBrand(env?: Record<string, string | undefined>): Brand;
