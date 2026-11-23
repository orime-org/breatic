// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Linux update manifest (inner#2041, design §9.1.2). The AppImage and the deb
 * are packed in two runs so the deb's package-type marker never lands in the
 * AppImage; each run writes its own latest-linux.yml, and the second would
 * replace the first. The release publishes one manifest listing both, since
 * each updater picks its own file from it by extension.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parse } from "yaml";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "linux-manifest.mjs");

/** The merge, an ES module the release script uses. */
type Module = { mergeLinuxManifests: (appImage: string, deb: string) => string };

/**
 * Import the merge.
 * @returns The module.
 */
async function load(): Promise<Module> {
  return (await import(SCRIPT)) as Module;
}

const APPIMAGE = `version: 0.2.0
files:
  - url: breatic-0.2.0-linux-x86_64.AppImage
    sha512: aaa
    size: 100
    blockMapSize: 10
path: breatic-0.2.0-linux-x86_64.AppImage
sha512: aaa
releaseDate: '2026-11-22T00:00:00.000Z'
`;

const DEB = `version: 0.2.0
files:
  - url: breatic-0.2.0-linux-amd64.deb
    sha512: bbb
    size: 90
path: breatic-0.2.0-linux-amd64.deb
sha512: bbb
releaseDate: '2026-11-22T00:00:01.000Z'
`;

describe("mergeLinuxManifests", () => {
  it("lists the AppImage and the deb, with the AppImage as the default file", async () => {
    const merged = parse((await load()).mergeLinuxManifests(APPIMAGE, DEB)) as Record<string, unknown>;
    expect(merged.version).toBe("0.2.0");
    expect((merged.files as { url: string }[]).map((file) => file.url)).toEqual([
      "breatic-0.2.0-linux-x86_64.AppImage",
      "breatic-0.2.0-linux-amd64.deb",
    ]);
    expect(merged.path).toBe("breatic-0.2.0-linux-x86_64.AppImage");
    expect(merged.sha512).toBe("aaa");
  });

  it("keeps the release date a quoted string, as electron-builder writes it", async () => {
    expect((await load()).mergeLinuxManifests(APPIMAGE, DEB)).toContain("releaseDate: '2026-11-22T00:00:00.000Z'");
  });

  it("refuses manifests of two different versions", async () => {
    const { mergeLinuxManifests } = await load();
    expect(() => mergeLinuxManifests(APPIMAGE, DEB.replaceAll("0.2.0", "0.2.1"))).toThrow(/version/);
  });
});
