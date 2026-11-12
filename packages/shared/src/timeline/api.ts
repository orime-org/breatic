// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The public request contract bounds video-page requests before config clamping. */
export const MAX_TIMELINE_ASSET_PAGE_SIZE = 1000;

/** The multi-video preview sync thresholds (#1410), in seconds except the steer rate. */
export interface TimelinePreviewSyncLimits {
  /** Drift past which a lane's playback rate is steered. */
  driftSteerSeconds: number;
  /** Drift, and drift jump, past which a lane is hard-synced. */
  driftHardSyncSeconds: number;
  /** Drift past which a lane is hard-synced however it got there. */
  driftCatastrophicSeconds: number;
  /** When a wait ends, lanes not waited for are sought only past this offset. */
  resumeSeekSeconds: number;
  /** The fraction a steered lane's rate is raised or lowered by. */
  driftSteerRate: number;
}

/** The values core's config defaults to and web plays with before the Timeline limits arrive. */
export const TIMELINE_PREVIEW_DEFAULTS: TimelinePreviewSyncLimits = {
  driftSteerSeconds: 0.04,
  driftHardSyncSeconds: 0.5,
  driftCatastrophicSeconds: 3,
  resumeSeekSeconds: 0.15,
  driftSteerRate: 0.03,
};

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
    /** How far ahead of its first visible frame the preview loads a video clip's element or a web copy's page. */
    premountMs?: number;
    /** How many loaded preview pages no copy uses are kept for reuse. */
    idleInstancesMax?: number;
  };
  preview: TimelinePreviewSyncLimits;
}
