// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A build is made for one brand (inner#2041, design §9.1.1). The brand directory
 * names the app, its ID, server and images; every name that must differ
 * between two brands installed on one machine comes from the brand's `id`,
 * and the sign-in return scheme is the app ID in lower case, a reverse domain
 * name no website can register.
 */

import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE = join(import.meta.dirname, "..", "..", "..");
const ACME = join(import.meta.dirname, "fixtures", "acme");
const OFFICIAL = join(PACKAGE, "brands", "breatic");

/** The brand loader, an ES module the build scripts share. */
type BrandModule = {
  loadBrand: (dir: string, env?: Record<string, string | undefined>) => Record<string, unknown>;
};

/**
 * Import the loader.
 * @returns The module.
 */
async function brands(): Promise<BrandModule> {
  return (await import(join(PACKAGE, "brand.mjs"))) as BrandModule;
}

/**
 * A copy of the partner fixture with some brand.json fields replaced.
 * @param over - The fields to replace.
 * @returns The copy's directory.
 */
function acmeWith(over: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "brand-"));
  cpSync(ACME, dir, { recursive: true });
  const brand = JSON.parse(readFileSync(join(dir, "brand.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "brand.json"), JSON.stringify({ ...brand, ...over }));
  return dir;
}

describe("loadBrand", () => {
  it("reads the official brand: its own server, no attribution line", async () => {
    const brand = (await brands()).loadBrand(OFFICIAL, {});
    expect(brand).toMatchObject({
      id: "breatic",
      productName: "Breatic",
      appId: "ai.breatic.desktop",
      scheme: "ai.breatic.desktop",
      serverUrl: (JSON.parse(readFileSync(join(OFFICIAL, "brand.json"), "utf8")) as { serverUrl: string }).serverUrl,
      poweredBy: false,
      packageName: "breatic",
      executableName: "breatic",
    });
  });

  it("derives every per-brand name from a partner's brand and shows the attribution", async () => {
    const brand = (await brands()).loadBrand(ACME, {});
    expect(brand).toMatchObject({
      id: "acme",
      productName: "Acme Studio",
      scheme: "com.acme.studio",
      poweredBy: true,
      packageName: "acme",
      executableName: "acme",
      newWindowExec: '"/opt/Acme Studio/acme" --new-window',
      appImageEntryName: "acme-appimage.desktop",
      artifactName: "acme-${version}-${os}-${arch}.${ext}",
    });
    expect(brand.icon).toBe(join(ACME, "icon.png"));
    expect(brand.logo).toBe(join(ACME, "logo.svg"));
  });

  it("lets a non-empty BREATIC_DEFAULT_SERVER_URL replace the server, and ignores an empty one", async () => {
    const { loadBrand } = await brands();
    expect(loadBrand(ACME, { BREATIC_DEFAULT_SERVER_URL: "http://localhost:8100" }).serverUrl).toBe("http://localhost:8100");
    expect(loadBrand(ACME, { BREATIC_DEFAULT_SERVER_URL: "" }).serverUrl).toBe("https://studio.acme.test");
  });

  it.each([
    ["an app ID that is not a reverse domain name", { appId: "acme" }, /appId/],
    ["an id with capitals", { id: "Acme" }, /id/],
    ["an empty product name", { productName: "" }, /productName/],
    ["a missing logo", { logo: "missing.svg" }, /logo/],
  ])("refuses %s", async (_label, over, message) => {
    const { loadBrand } = await brands();
    expect(() => loadBrand(acmeWith(over), {})).toThrow(message);
  });
});
