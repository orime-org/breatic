// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who pays for a mini-tool run or analysis (inner#1306 frames-split design §5.5): the platform funds frame extraction,
 * focus crop and people detection; everything else is charged to the user. A product rule, so it lives in code, not yaml.
 */

/** The tool ids and analysis kinds the platform pays for. */
export const PLATFORM_FUNDED: ReadonlySet<string> = new Set(["video.extract-frames", "video.focus-crop", "people"]);

/**
 * Who a run of this tool or analysis kind is charged to, frozen into its plan at admission.
 * @param subject - A tool id or an analysis kind.
 * @returns `platform` for a platform-funded subject, otherwise `user`.
 */
export function miniToolChargeTo(subject: string): "platform" | "user" {
  return PLATFORM_FUNDED.has(subject) ? "platform" : "user";
}
