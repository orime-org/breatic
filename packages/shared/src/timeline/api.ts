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
    /** The accepted range in seconds, and the duration the creation dialog opens at. */
    durationSeconds: { min: number; max: number; default: number };
    /** The aspects the creation dialog offers, in the configured order. */
    aspects: string[];
    playerLoadTimeoutMs: number;
    sourceRefreshIntervalMs: number;
    /**
     * How long a signed preview address stays readable; the preview shares one address within it. The server always
     * sends this and the two below; a client without them shares no address and premounts and keeps no page.
     */
    previewTokenTtlMs?: number;
    /** How far ahead of a web copy's first visible frame the preview loads its page. */
    premountMs?: number;
    /** How many loaded preview pages no copy uses are kept for reuse. */
    idleInstancesMax?: number;
  };
}
