// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One face of the font set's `faces.json`, as `scripts/web-animation-fonts.mjs` writes it. The web-animation container
 * reads the file too and imports only this type, so the module stays free of zod; `TimelineFontFaceSchema` checks it.
 */
export interface TimelineFontFace {
  family: string;
  /** The file name without `.woff2`. */
  file: string;
  unicodeRange: string;
  /** The variable weight range, `100 900` when not given. */
  weight?: string;
}
