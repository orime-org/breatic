// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Bytes and numbers the arbiter tests and their host share.
 */

/** What the stand-in run writes back. */
export const UPRIGHT_BYTES = new TextEncoder().encode("upright bytes");

/** What the stand-in run cuts as a preview. */
export const PREVIEW_STUB = new TextEncoder().encode("preview bytes");

/** What the stand-in run measures. */
export const MEDIA_DIMENSIONS_STUB = { width: 768, height: 1024, durationSeconds: null };
