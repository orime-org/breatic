// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The public request contract bounds video-page requests before config clamping. */
export const MAX_TIMELINE_ASSET_PAGE_SIZE = 1000;

/** Public Timeline defaults and client transport limits, excluding server-only knobs. */
export interface TimelineClientLimits {
  defaults: { width: number; height: number; fps: { num: number; den: number } };
  assets: { pageSize: number; pageMax: number };
  persistence: { batchSize: number; pollIntervalMs: number; rpcTimeoutMs: number; retryMinIntervalMs: number };
}
