// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The public request contract bounds video-page requests before config clamping. */
export const MAX_TIMELINE_ASSET_PAGE_SIZE = 1000;

/** Public Timeline creation defaults, Project media limits and the web-animation dialog and preview settings. */
export interface TimelineClientLimits {
  defaults: { width: number; height: number; fps: { num: number; den: number } };
  assets: { pageSize: number; pageMax: number };
  webAnimation: {
    promptMaxLength: number;
    durationSeconds: { min: number; max: number };
    /** The aspects the creation dialog offers, in the configured order. */
    aspects: string[];
    playerLoadTimeoutMs: number;
    sourceRefreshIntervalMs: number;
  };
}
