// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { createClassPatternRule } from "#rules/class-pattern-rule";

/**
 * A neutral border that signals selection uses the one activation colour.
 *
 * When a border says "this is selected, focused, active" in black, white or
 * grey, it must be `border-active-border` — the same colour an input shows
 * on focus. Reaching for `border-primary` or `border-foreground` instead
 * gives the same meaning two different looks, which is how the resolution
 * picker once drifted.
 *
 * Colour-semantic borders are a separate system and unconstrained: a status
 * border or a palette colour carries its own meaning.
 */
export const activeBorder = createClassPatternRule({
  name: "active-border",
  description: "A neutral border signalling activation uses border-active-border",
  // The state variant and the neutral border must be adjacent, separated
  // only by the colon — a file mentioning them on separate lines is fine.
  // The variant has no left boundary, so group- and peer- prefixes match by
  // substring, as they did before. Order inside the alternations matters:
  // `muted` precedes `muted-foreground`, and backtracking is what lets the
  // longer one still match against the trailing boundary.
  forbidden:
    /(focus|focus-within|focus-visible|aria-\[current[^\]]*\]|aria-selected|data-\[state=(checked|selected|on|active)\]):border-(primary|secondary|accent|muted|muted-foreground|foreground|input|ring|border|neutral-[0-9]+|white|black)([^a-zA-Z-]|$)/,
  message:
    "{{match}} expresses activation in a neutral colour that is not the activation border. Use border-active-border, the colour an input shows on focus.",
});
