// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { createClassPatternRule } from "#rules/class-pattern-rule";

/**
 * Colours come from tokens, so they follow the light and dark themes.
 *
 * A literal hex is one fixed colour. It cannot be mode-aware, so it reads
 * correctly in one theme and wrong in the other, and it sits outside every
 * contrast guarantee the token palette makes.
 *
 * Separate from the other raw-value checks because it needs exemptions they
 * do not, and those live in the config: the brand mark is a fixed logo
 * colour by definition, and the inpaint brush works in pigment rather than
 * in UI surfaces. Both are live — four files rely on them today.
 *
 * The guard also excused the token definition file, and that one IS dead:
 * its include filter only ever read .ts and .tsx, so a .css file never
 * reached the check. It is not carried over, because an exemption that
 * cannot fire only serves to admit a real violation there later.
 */
export const noRawHexColor = createClassPatternRule({
  name: "no-raw-hex-color",
  description: "Colours come from tokens rather than literal hex values",
  forbidden: /#[0-9a-fA-F]{6}\b/,
  allowMarker: "design-value: allow",
  message:
    "{{match}} is a fixed colour, so it cannot follow the light and dark themes. Use a semantic token.",
});
