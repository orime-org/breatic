// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { createClassPatternRule } from "#rules/class-pattern-rule";

/**
 * Visible scrollers go through the Scroller component.
 *
 * A native scrollbar is drawn by the browser, so it looks different in every
 * engine and its hover behaviour is not specified anywhere — the width and
 * colour a page can set are the only parts standardised. For a creative
 * tool that inconsistency is not cosmetic. The Scroller draws its own, which
 * also gives it the overlay behaviour, the hover treatment and the
 * zoom-correct dragging the native one cannot promise.
 *
 * A scroller with a deliberately hidden bar is exempt: there is no scrollbar
 * to be inconsistent about.
 */
export const noInlineScrollbar = createClassPatternRule({
  name: "no-inline-scrollbar",
  description: "Visible scrollers use the Scroller component",
  forbidden:
    /::-webkit-scrollbar|scrollbar-width:(thin|auto)|scrollbar-color|overflow-(auto|scroll|y-auto|y-scroll|x-auto|x-scroll)/,
  exemptWholeString: /\[scrollbar-width:none\]/,
  stripAllowed: /\[&::-webkit-scrollbar\]:hidden/g,
  message:
    "{{match}} makes the browser draw the scrollbar, which differs per engine. Wrap the content in the Scroller component.",
});
