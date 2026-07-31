// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { createClassPatternRule } from "#rules/class-pattern-rule";

/**
 * Borders and focus rings are one pixel, with no offset glow.
 *
 * A heavier border reads as a different weight of emphasis than the rest of
 * the interface, and a ring offset draws a gap that looks like a glow. Both
 * make one control louder than its neighbours for no reason the user can
 * name. The vendor primitives are scanned too: ours are token-customised
 * rather than pristine shadcn, so the rule applies to them as much.
 */
export const onePxBorder = createClassPatternRule({
  name: "one-px-border",
  description: "Borders and focus rings are 1px, without a ring offset",
  // Copied from the guard character for character. The single-digit range
  // and the trailing non-digit are deliberate: ring-10 and border-12 do not
  // match, and widening to \d+ would start failing code that passes today.
  // `ring-offset` alone carries no boundaries, so it matches anywhere.
  forbidden:
    /ring-offset|(^|[^a-zA-Z0-9-])ring-[2-9]([^0-9]|$)|(^|[^a-zA-Z0-9-])border(-[trblxy])?-[2-9]([^0-9]|$)|ring-\[[2-9]|border-\[[2-9]/,
  message:
    "{{match}} is heavier than the one-pixel border the rest of the interface uses (a ring offset draws a glow gap). Use border / border-1 and ring-1.",
});
