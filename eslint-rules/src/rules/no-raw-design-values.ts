// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { createClassPatternRule } from "#rules/class-pattern-rule";

/**
 * Sizes, radii and neutrals come from design tokens, not from raw values.
 *
 * A hardcoded `text-[13px]` or `rounded-[6px]` looks right until the scale
 * moves, and then it is one of a hundred places that quietly did not move
 * with it. The neutral primitives are worse: reaching a `--neutral-*`
 * directly skips the semantic layer that decides what that grey means in
 * light versus dark.
 *
 * Consuming a token through an arbitrary value is fine — `h-[var(--btn-chrome)]`
 * is how a token is used, not a raw number. Geometry that is not on the
 * button ladder is also fine; only the four ladder sizes are locked.
 */
export const noRawDesignValues = createClassPatternRule({
  name: "no-raw-design-values",
  description: "Sizes, radii and neutrals come from design tokens",
  // Four of the guard's five checks. The hex-colour check is its own rule
  // because it carries exemptions the others do not.
  forbidden:
    /text-\[[0-9.]+px\]|\[var\(--neutral|rounded-\[[0-9]+px\]|\b(h|w|size|min-h|min-w|max-h|max-w)-\[(24|28|32|44)px\]/,
  allowMarker: "design-value: allow",
  message:
    "{{match}} hardcodes a value the design tokens own, so it will not follow when the scale moves. Consume the token instead.",
});
