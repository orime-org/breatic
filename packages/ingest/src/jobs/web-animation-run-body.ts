// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the web-animation Durable Object and its container agree on (inner#1711 design §6): where the runner listens,
 * the run it is handed and what it posts back to `jobs.local`. Here once, because both sides read it.
 */

/** The port the web-animation runner listens on. */
export const WEB_ANIMATION_PORT = 8080;

/** The one endpoint the runner serves: start a run, answered 202 before the run goes on. */
export const WEB_ANIMATION_RUN_PATH = "/run";

/** Where the runner posts its phase and steps on `jobs.local`. */
export const WEB_ANIMATION_PROGRESS_PATH = "/progress";

/** Where the runner posts how its run ended on `jobs.local`. */
export const WEB_ANIMATION_REPORT_PATH = "/report";

/** What the object posts to the runner. */
export interface WebAnimationRunBody {
  prompt: string;
  viewport: { width: number; height: number };
  fps: { num: number; den: number };
  durationFrames: number;
  fontSetVersion: number;
  maxPackageBytes: number;
  /** Where the runner PUTs the package and the Manifest, through `r2.local`. */
  packageUrl: string;
  manifestUrl: string;
  /** Where it posts progress and its final report, through `jobs.local`. */
  progressUrl: string;
  reportUrl: string;
  /** A modification's base: the package to start from, read by GET through `r2.local`, with its frame and length. */
  base?: { packageUrl: string; viewport: { width: number; height: number }; durationFrames: number };
}

/** The port the render runner listens on, and its paths, are the creation runner's. */
export interface WebAnimationRenderRunBody {
  /** The source package, read by GET through `r2.local`. */
  packageUrl: string;
  fontSetVersion: number;
  width: number;
  height: number;
  fps: { num: number; den: number };
  durationFrames: number;
  quality: string;
  /** Where the runner PUTs the video and its first-frame cover, through `r2.local`. */
  videoUrl: string;
  coverUrl: string;
  progressUrl: string;
  reportUrl: string;
}

/** What the render runner posts to the progress path. */
export interface WebAnimationRenderProgressBody {
  phase: "rendering" | "saving";
  /** How far the renderer got, 0 to 1. */
  progress: number;
}

/** What the render runner posts to the report path; the media fields are what ffprobe measured of what it wrote. */
export interface WebAnimationRenderReportBody {
  ok: boolean;
  failureReason: string | null;
  cpuUsec: number | null;
  video: { width: number; height: number; durationSeconds: number } | null;
  cover: { width: number; height: number } | null;
}

/** The phases a run reports. */
export type WebAnimationRunPhase = "writing" | "validating" | "saving";

/** What the runner posts to the progress path. */
export interface WebAnimationProgressBody {
  phase: WebAnimationRunPhase;
  steps: unknown[];
}

/** What the runner posts to the report path. */
export interface WebAnimationReportBody {
  ok: boolean;
  failureReason: string | null;
  cpuUsec: number | null;
}
