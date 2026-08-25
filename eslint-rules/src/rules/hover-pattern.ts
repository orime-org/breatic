// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { createClassPatternRule } from "#rules/class-pattern-rule";

/**
 * Hover states swap the token or dim the element; they do not fade it.
 *
 * `hover:bg-<token>/50` renders the surface semi-transparent, so whatever
 * sits behind it bleeds through and the hover colour depends on the
 * backdrop. A solid token swap or `hover:opacity-90` keeps the result the
 * same wherever the element is placed.
 *
 * Black and white overlays are the exception: those are scrims over media,
 * where the whole point is that the image shows through.
 */
export const hoverPattern = createClassPatternRule({
  name: "hover-pattern",
  description: "Hover states swap a token rather than fading it with alpha",
  forbidden: /hover:bg-[a-z][a-z0-9-]*\/[0-9]{2}/,
  exemptWholeString: /hover:bg-(black|white)\/[0-9]/,
  message:
    "{{match}} fades the surface, so the hover colour depends on whatever is behind it. Swap the token, or use hover:opacity-90.",
});
