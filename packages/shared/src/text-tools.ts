// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The choices the text mini-tool's contract offers (inner#1860): web shows
 * them in the document's AI menu, the server's request schema accepts exactly
 * these, so both read them from here.
 */

/** The languages a selection can be translated into, in the order they are offered. */
export const TEXT_TOOL_LANGUAGES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;

/** A language a selection can be translated into. */
export type TextToolLanguage = (typeof TEXT_TOOL_LANGUAGES)[number];

/** The tones a selection can be rewritten in, in the order they are offered. */
export const TEXT_TOOL_TONES = ["professional", "casual", "straightforward", "confident", "friendly"] as const;

/** A tone a selection can be rewritten in. */
export type TextToolTone = (typeof TEXT_TOOL_TONES)[number];

/** The most a custom instruction may say: the box holds no more, the request schema accepts no more. */
export const TEXT_TOOL_INSTRUCTIONS_MAX = 2_000;
