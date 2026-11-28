// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The font set under `/web-animation/fonts/` is read by every Timeline preview with text, so the ingest Worker serves
 * it whether or not web animation is enabled (inner#1709 design §5.3): `wrangler.toml.template` enables `[assets]` at
 * the top level and in `[env.production]`, while the web-animation container blocks stay commented out.
 *
 * Each case starts a local Worker from the committed template as a developer would fill it in. What filling in
 * changes is only what the test cannot hold: `<placeholder>` values get stand-ins, the `[[containers]]` blocks go
 * (their images need Docker; no container is reached here), the R2 bucket stays local and `main` names this
 * package's entry. The assets directory beside the copy holds this package's `_headers` and a stand-in
 * `glyphs.json`.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";

const PKG = resolve(__dirname, "../..");
const FONT_PATH = "web-animation/fonts/v3/glyphs.json";
const FONT_BODY = '[{"file":"inter-latin-wght-normal","glyphRange":"U+20-7E"}]\n';

let dir = "";

/**
 * Write a filled-in copy of the template, and the assets beside it, into the temp directory.
 * @returns The copy's path.
 */
function fillInTemplate(): string {
  const template = readFileSync(join(PKG, "wrangler.toml.template"), "utf8");
  const filled = template
    .split(/^(?=\[)/m)
    .filter((block) => !/^\[\[(env\.production\.)?containers\]\]/.test(block))
    .join("")
    .replace(/^(\s*bucket_name\s*=\s*)"<[^>]*>"/gm, '$1"breatic-test-bucket"')
    .replace(/"<[^>]*>"/g, '""')
    .replace(/<[^>]*>/g, "8999")
    .replace(/^\s*remote\s*=\s*true\s*$/gm, "")
    .replace(/^main\s*=.*$/m, `main = ${JSON.stringify(join(PKG, "src/index.ts"))}`);
  const config = join(dir, "wrangler.toml");
  writeFileSync(config, filled);
  mkdirSync(join(dir, "assets/web-animation/fonts/v3"), { recursive: true });
  copyFileSync(join(PKG, "assets/_headers"), join(dir, "assets/_headers"));
  writeFileSync(join(dir, "assets", FONT_PATH), FONT_BODY);
  return config;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-font-assets-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the font set on a Worker without web animation", () => {
  it("keeps the web-animation containers out of the template by default", () => {
    const active = readFileSync(join(PKG, "wrangler.toml.template"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(active).not.toMatch(/WebAnimation(Render)?Container/);
  });

  it.each([
    ["the development Worker", undefined],
    ["the production Worker", "production"],
  ])("is served by %s the template configures, to any origin, cached as immutable", async (_name, env) => {
    const worker = await unstable_startWorker({
      config: fillInTemplate(),
      ...(env !== undefined && { env }),
      dev: { server: { port: 0 }, inspector: false, enableContainers: false, logLevel: "error" },
    });
    try {
      const response = await worker.fetch(`http://localhost/${FONT_PATH}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(FONT_BODY);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    } finally {
      await worker.dispose();
    }
  }, 120_000);
});
