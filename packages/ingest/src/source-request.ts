// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the Worker names itself when it pulls a source a link points at.
 *
 * A Worker's fetch sends no User-Agent of its own, and sites that serve
 * files to the public refuse an anonymous request: Wikimedia answers 403
 * without one and the file with one. The value names us and where to find us,
 * as such sites ask.
 */
export const SOURCE_USER_AGENT = "Breatic/1.0 (+https://breatic.ai)";
