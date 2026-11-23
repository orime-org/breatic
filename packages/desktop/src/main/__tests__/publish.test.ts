// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Publishing a release to the update feed (inner#2041, design §9.3). Only a
 * `desktop-v{version}` tag publishes, and its version must be the package's:
 * clients compare versions to decide there is an update. Installers, zips and
 * blockmaps go up first and the manifests last, so a client that reads a new
 * manifest finds the files it names.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "publish.mjs");

/** The publish helpers. */
type Module = {
  releaseVersion: (tag: string, packageVersion: string) => string;
  publishOrder: (files: string[]) => string[];
  missingPublishSettings: (env: Record<string, string | undefined>) => string[];
};

/**
 * Import the helpers.
 * @returns The module.
 */
async function load(): Promise<Module> {
  return (await import(SCRIPT)) as Module;
}

describe("releaseVersion", () => {
  it("takes the version a desktop tag names when the package says the same", async () => {
    expect((await load()).releaseVersion("desktop-v0.2.0", "0.2.0")).toBe("0.2.0");
  });

  it.each([
    ["desktop-v0.2.1", "0.2.0", /0\.2\.1.*0\.2\.0/],
    ["v0.2.0", "0.2.0", /desktop-v/],
    ["", "0.2.0", /desktop-v/],
  ])("refuses tag %j for package version %s", async (tag, version, message) => {
    const { releaseVersion } = await load();
    expect(() => releaseVersion(tag, version)).toThrow(message);
  });
});

describe("publishOrder", () => {
  it("puts installers, zips and blockmaps first and every manifest last, leaving build logs out", async () => {
    const order = (await load()).publishOrder([
      "latest-mac.yml",
      "breatic-0.2.0-mac-arm64.zip",
      "builder-debug.yml",
      "breatic-0.2.0-mac-arm64.dmg",
      "breatic-0.2.0-mac-arm64.zip.blockmap",
      "latest-linux.yml",
      "breatic-0.2.0-win-x64.exe",
      "breatic-0.2.0-win-x64.exe.blockmap",
      "latest.yml",
      "breatic-0.2.0-linux-x86_64.AppImage",
      "breatic-0.2.0-linux-amd64.deb",
      "builder-effective-config.yaml",
    ]);
    const firstManifest = order.findIndex((file) => file.endsWith(".yml"));
    expect(order.slice(firstManifest).sort()).toEqual(["latest-linux.yml", "latest-mac.yml", "latest.yml"]);
    expect(order.slice(0, firstManifest).sort()).toEqual([
      "breatic-0.2.0-linux-amd64.deb",
      "breatic-0.2.0-linux-x86_64.AppImage",
      "breatic-0.2.0-mac-arm64.dmg",
      "breatic-0.2.0-mac-arm64.zip",
      "breatic-0.2.0-mac-arm64.zip.blockmap",
      "breatic-0.2.0-win-x64.exe",
      "breatic-0.2.0-win-x64.exe.blockmap",
    ]);
  });
});

describe("missingPublishSettings", () => {
  const complete = {
    BREATIC_UPDATE_BASE_URL: "https://updates.example.test/desktop",
    R2_UPDATES_BUCKET: "b",
    R2_UPDATES_ENDPOINT: "https://r2.example.test",
    AWS_ACCESS_KEY_ID: "k",
    AWS_SECRET_ACCESS_KEY: "s",
  };

  it("asks for nothing when every setting is there", async () => {
    expect((await load()).missingPublishSettings(complete)).toEqual([]);
  });

  it("names the feed address: without it the packages read no feed and never update", async () => {
    const { missingPublishSettings } = await load();
    expect(missingPublishSettings({ ...complete, BREATIC_UPDATE_BASE_URL: " " })).toEqual(["BREATIC_UPDATE_BASE_URL"]);
    expect(missingPublishSettings({})).toEqual(Object.keys(complete));
  });
});
