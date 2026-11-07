// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation runner's own decisions (inner#1711 design §3.6, §6), the parts that need no Chromium and no
 * model: the Manifest it writes, the font-set stylesheet, the order in which it inlines the runtime, the frame-ready
 * bridge and the font stylesheet into the package, the verdict it draws from what Chromium measured, and the
 * environment it starts dsh in.
 *
 * Loading the package in Chromium, the CDP font query and the screenshots are the runner's I/O; what they measure is
 * handed to `judgeWebAnimationCheck` as plain numbers and strings, so the rules are pinned here and the measuring is
 * verified against the real image.
 */

import { describe, expect, it } from "vitest";

import { durationToFrames } from "@shared/timeline/time.js";
import { WebAnimationManifestSchema, matchWebAnimationManifest } from "@shared/timeline/web-animation.js";

import {
  WEB_ANIMATION_FONT_FAMILIES,
  buildFontSetStylesheet,
  buildWebAnimationManifest,
  judgeWebAnimationCheck,
  packWebAnimationSource,
  webAnimationDshEnv,
  type WebAnimationCheckExpectation,
  type WebAnimationCheckObservation,
} from "../web-animation-package.js";

const REQUEST = {
  viewport: { width: 1080, height: 1920 },
  fps: { num: 30_000, den: 1_001 },
  durationFrames: durationToFrames(5, { num: 30_000, den: 1_001 }),
  fontSetVersion: 1,
};

describe("buildWebAnimationManifest", () => {
  it("writes a Manifest the shared schema accepts and the accepted input matches", () => {
    const manifest = buildWebAnimationManifest(REQUEST);

    expect(WebAnimationManifestSchema.parse(manifest)).toEqual({
      schemaVersion: 1,
      entrypoint: "index.html",
      viewport: { width: 1080, height: 1920 },
      fps: { num: 30_000, den: 1_001 },
      durationFrames: REQUEST.durationFrames,
      resources: [{ kind: "font-set", version: 1 }],
      runtime: { id: "hyperframes", version: "0.8.186" },
    });
    expect(matchWebAnimationManifest(manifest, REQUEST)).toBeNull();
  });
});

describe("the font set", () => {
  it("allows exactly the three families the design names", () => {
    expect([...WEB_ANIMATION_FONT_FAMILIES]).toEqual(["Noto Sans SC", "Noto Serif SC", "Inter"]);
  });

  it("declares only @font-face rules whose files resolve beside the package under the version's directory", () => {
    const css = buildFontSetStylesheet(3, [
      { family: "Noto Sans SC", file: "noto-sans-sc-chinese-simplified-wght-normal", unicodeRange: "U+4E00-9FFF" },
      { family: "Inter", file: "inter-latin-wght-normal", unicodeRange: "U+0000-00FF" },
    ]);

    const rules = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(rules).toHaveLength(2);
    expect(css.replace(/@font-face\s*\{[^}]*\}/g, "").trim()).toBe("");
    expect(rules[0]).toMatch(/font-family:\s*"Noto Sans SC"/);
    expect(rules[0]).toContain("url(\"../fonts/v3/noto-sans-sc-chinese-simplified-wght-normal.woff2\") format(\"woff2\")");
    expect(rules[0]).toMatch(/unicode-range:\s*U\+4E00-9FFF/);
    expect(rules[1]).toMatch(/font-family:\s*"Inter"/);
    expect(rules[1]).toContain("url(\"../fonts/v3/inter-latin-wght-normal.woff2\")");
  });

  it("refuses a family outside the set", () => {
    expect(() => buildFontSetStylesheet(1, [{ family: "Arial", file: "arial", unicodeRange: "U+0000-00FF" }])).toThrow(RangeError);
  });
});

describe("packWebAnimationSource", () => {
  const composition = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>Composition</title></head>",
    "<body><div id=\"stage\" data-composition-id=\"main\" data-duration=\"5\" data-width=\"1080\" data-height=\"1920\">",
    "<h1 class=\"title\">Hello</h1></div>",
    "<script>window.__composition = true;</script>",
    "</body></html>",
  ].join("\n");
  const pieces = {
    composition,
    runtime: "/*RUNTIME*/window.__hf = {};",
    bridge: "/*BRIDGE*/window.__bridge = {};",
    fontStylesheet: "/*FONTS*/@font-face{font-family:\"Inter\";src:url(\"../fonts/v1/inter.woff2\") format(\"woff2\")}",
  };

  it("keeps the composition and inlines the runtime, then the bridge, then the font stylesheet", () => {
    const html = packWebAnimationSource(pieces);

    expect(html).toContain("<h1 class=\"title\">Hello</h1>");
    expect(html).toContain("<script>window.__composition = true;</script>");
    const runtime = html.indexOf("/*RUNTIME*/");
    const bridge = html.indexOf("/*BRIDGE*/");
    const fonts = html.indexOf("/*FONTS*/");
    expect(runtime).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(runtime);
    expect(fonts).toBeGreaterThan(bridge);
  });

  it("inlines the runtime and bridge as script elements and the fonts as a style element, referencing no file", () => {
    const html = packWebAnimationSource(pieces);

    expect(html).toMatch(/<script>\s*\/\*RUNTIME\*\//);
    expect(html).toMatch(/<script>\s*\/\*BRIDGE\*\//);
    expect(html).toMatch(/<style>\s*\/\*FONTS\*\//);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*stylesheet/);
  });

  it("keeps an inlined script from closing its own element early", () => {
    const html = packWebAnimationSource({ ...pieces, runtime: "var tag = \"</script><b>escaped</b>\";" });

    expect(html).not.toContain("\"</script><b>escaped</b>\"");
    expect(html).toContain("<\\/script>");
  });
});

describe("judgeWebAnimationCheck", () => {
  const expected: WebAnimationCheckExpectation = {
    viewport: REQUEST.viewport,
    fps: REQUEST.fps,
    durationFrames: REQUEST.durationFrames,
    maxPackageBytes: 5_000_000,
    fontRequestPrefix: "http://127.0.0.1:9100/web-animation/fonts/v1/",
  };
  const passing: WebAnimationCheckObservation = {
    durationSeconds: 5,
    viewport: { width: 1080, height: 1920 },
    seekRepeat: ["hash-a", "hash-a"],
    seekDirections: ["hash-b", "hash-b"],
    textFonts: [
      { family: "Noto Sans SC", isCustomFont: true },
      { family: "Inter", isCustomFont: true },
    ],
    requests: [
      "http://127.0.0.1:9100/web-animation/fonts/v1/noto-sans-sc-chinese-simplified-wght-normal.woff2",
      "data:image/png;base64,iVBORw0KGgo=",
    ],
    packageBytes: 120_000,
  };

  it("passes a package that matches its Manifest, renders the same frame each way and uses only the font set", () => {
    expect(judgeWebAnimationCheck(passing, expected)).toBeNull();
  });

  it.each<[string, Partial<WebAnimationCheckObservation>, string]>([
    ["no readable data-duration", { durationSeconds: null }, "duration_unreadable"],
    ["a data-duration the input did not ask for", { durationSeconds: 4 }, "duration_mismatch"],
    ["no readable viewport", { viewport: null }, "viewport_mismatch"],
    ["another viewport", { viewport: { width: 1920, height: 1080 } }, "viewport_mismatch"],
    ["two different frames for the same time", { seekRepeat: ["hash-a", "hash-c"] }, "seek_not_repeatable"],
    ["different frames seeking forward and backward to the same time", { seekDirections: ["hash-b", "hash-d"] }, "seek_direction_mismatch"],
    ["a system font", { textFonts: [{ family: "Noto Sans SC", isCustomFont: false }] }, "font_not_in_set"],
    ["a web font outside the set", { textFonts: [{ family: "Roboto", isCustomFont: true }] }, "font_not_in_set"],
    ["a request outside the font set", { requests: ["https://fonts.googleapis.com/css2?family=Roboto"] }, "external_request"],
    ["a font of another font-set version", { requests: ["http://127.0.0.1:9100/web-animation/fonts/v2/inter.woff2"] }, "external_request"],
    ["a package over the size limit", { packageBytes: 5_000_001 }, "package_too_large"],
  ])("fails a package with %s", (_label, change, reason) => {
    expect(judgeWebAnimationCheck({ ...passing, ...change }, expected)).toBe(reason);
  });

  it("accepts a package of exactly the size limit and a page with no text", () => {
    expect(judgeWebAnimationCheck({ ...passing, packageBytes: 5_000_000, textFonts: [] }, expected)).toBeNull();
  });
});

describe("webAnimationDshEnv", () => {
  it("points dsh at model.local with a placeholder key, telemetry off and full permissions inside the container", () => {
    const vars = webAnimationDshEnv({ HOME: "/work/home", PATH: "/usr/local/bin:/usr/bin" });

    expect(vars["DEEPSEEK_BASE_URL"]).toBe("http://model.local");
    expect(vars["DSH_TELEMETRY_MODE"]).toBe("DISABLED");
    expect(vars["DSH_PERMISSION_MODE"]).toBe("danger-full-access");
    expect(vars["DEEPSEEK_API_KEY"]).toEqual(expect.any(String));
    expect(vars["DEEPSEEK_API_KEY"]!.length).toBeGreaterThan(0);
    expect(vars["HOME"]).toBe("/work/home");
    expect(vars["PATH"]).toBe("/usr/local/bin:/usr/bin");
  });

  it("carries nothing it was not given beyond dsh's own settings", () => {
    const vars = webAnimationDshEnv({ HOME: "/work/home", PATH: "/usr/bin" });

    for (const name of Object.keys(vars)) {
      expect(["HOME", "PATH", "DSH_HOME", "DEEPSEEK_BASE_URL", "DEEPSEEK_API_KEY", "DSH_TELEMETRY_MODE", "DSH_PERMISSION_MODE"]).toContain(name);
    }
  });
});
