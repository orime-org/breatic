// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Versioned static JPEG encoding contract shared with the media container. */
export interface AgentPictureSpec {
  version: 1;
  longEdge: number;
  quality: number;
}

/** Facts measured after an immutable derived JPEG exists in storage. */
export type AgentPictureRead =
  | { outcome: "generated" | "existing"; sizeBytes: number; mediaType: "image/jpeg" }
  | { outcome: "none" | "failed" };
