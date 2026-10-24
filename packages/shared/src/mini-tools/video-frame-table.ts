// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** One decoded video sample in presentation order on its source clock. */
export interface VideoSourceFrame { frameIndex: number; pts: number }

/** A complete ordered frame sequence and its independently resolved endpoint. */
export interface VideoFrameTable { frames: readonly VideoSourceFrame[]; videoEnd: number }
