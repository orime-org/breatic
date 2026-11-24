// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The brand this build was made for (inner#2041, design §9.1.1), written in at
 * build time by tsup from the brand directory (brand.mjs). Everything the
 * client calls itself, the scheme it receives sign-ins on and the server it
 * opens come from here.
 */

/** The parts of a brand the running client needs. */
export interface BuildBrand {
  /** The brand id: names that must differ between brands derive from it. */
  id: string;
  /** The app's name as users see it. */
  productName: string;
  /** The sign-in return scheme, the app ID in lower case. */
  scheme: string;
  /** The server the build opens, an origin checked at build time (builtInServerUrl). */
  serverUrl: string;
  /** Whether the splash carries the "powered by" line: every brand but the official one. */
  poweredBy: boolean;
  /** The brand logo's file name beside the splash page. */
  splashLogo: string;
  /** The desktop entry an AppImage writes for the scheme; per brand, so two brands never overwrite each other's. */
  appImageEntryName: string;
}

declare const __BRAND__: BuildBrand;

/** This build's brand. */
export const BRAND: BuildBrand = __BRAND__;
