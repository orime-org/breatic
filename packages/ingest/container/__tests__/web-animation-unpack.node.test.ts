// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A modification starts from the composition its base result was made from (#1490 design §5.2): unpacking a source
 * package with the pieces it was packed with takes out exactly the three blocks packing inlined, wherever packing put
 * them, even when the composition's own text looks like a block opening.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { WEB_ANIMATION_BRIDGE_SCRIPT } from "@shared/timeline/web-animation-bridge.js";

import { buildFontSetStylesheet, packWebAnimationSource, unpackWebAnimationSource } from "../web-animation-package.js";

const RUNTIME = "(function(){var s='</script><!-- x -->';window.__hf=s;})();";
const FONTS = buildFontSetStylesheet(1, [{ family: "Inter", file: "inter-latin", unicodeRange: "U+0000-00FF" }]);
const pieces = { runtime: RUNTIME, bridge: WEB_ANIMATION_BRIDGE_SCRIPT, fontStylesheet: FONTS };

const fragment = fc.oneof(
  fc.constantFrom("<head>", "</head>", "</HEAD>", "<body>", "</body>", "</BODY>", "<html>", "</html>", "\n", "<script>", "</script>", "<style>", "</style>"),
  fc.string(),
);
const composition = fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join(""));

describe("unpackWebAnimationSource", () => {
  it("returns the composition packing started from", () => {
    fc.assert(fc.property(composition, (c) => unpackWebAnimationSource(packWebAnimationSource({ composition: c, ...pieces }), pieces) === c), { numRuns: 500 });
  });

  it("restores a composition with a head, where the blocks sit before </head>", () => {
    const c = "<!doctype html><html><head><title>x</title></head><body><div data-composition-id=\"main\"></div></body></html>";
    expect(unpackWebAnimationSource(packWebAnimationSource({ composition: c, ...pieces }), pieces)).toBe(c);
  });

  it("restores a composition with only a body, where the blocks sit before </body>", () => {
    const c = "<body><div data-composition-id=\"main\"></div></body>";
    expect(unpackWebAnimationSource(packWebAnimationSource({ composition: c, ...pieces }), pieces)).toBe(c);
  });

  it("restores a composition whose own text ends in a script opening", () => {
    for (const c of ["\n<script>", "<head><script>\n</head>", "<body>\n<script>\n</body>"]) {
      expect(unpackWebAnimationSource(packWebAnimationSource({ composition: c, ...pieces }), pieces)).toBe(c);
    }
  });

  it("refuses a package packed with another runtime", () => {
    const html = packWebAnimationSource({ composition: "<div></div>", ...pieces, runtime: "window.__hf=2;" });
    expect(() => unpackWebAnimationSource(html, pieces)).toThrow();
  });

  it("restores a composition with neither, where the blocks follow it", () => {
    const c = "<div data-composition-id=\"main\"></div>";
    expect(unpackWebAnimationSource(packWebAnimationSource({ composition: c, ...pieces }), pieces)).toBe(c);
  });
});
