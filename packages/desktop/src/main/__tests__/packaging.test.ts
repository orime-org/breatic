// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What electron-builder is told for a brand (#1599, design §9.1, §9.1.1,
 * §9.1.2): the brand's names, its scheme, a Debian launcher action that
 * starts this brand's executable, macOS zip next to the dmg, and an update
 * feed under the brand's directory only on builds whose platform can prove
 * who made the update: macOS and Windows only when signed, Linux whenever a
 * feed is set.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Configuration } from "electron-builder";

import { NEW_WINDOW_ARG } from "@desktop/main/new-window.js";
import { desktopText } from "@desktop/main/strings.js";

const PACKAGE = join(import.meta.dirname, "..", "..", "..");
const ACME = join(import.meta.dirname, "fixtures", "acme");
const FEED = "https://updates.example.test/desktop";
const SIGNED_WINDOWS = { AZURE_SIGNING_ENDPOINT: "e", AZURE_SIGNING_ACCOUNT: "a", AZURE_SIGNING_PROFILE: "p", AZURE_PUBLISHER_NAME: "Orime, Inc." };

/**
 * The configuration for an environment.
 * @param env - The environment the build runs in.
 * @returns electron-builder's configuration.
 */
async function configFor(env: Record<string, string>): Promise<Configuration> {
  const module = (await import(join(PACKAGE, "electron-builder.config.mjs"))) as { builderConfig: (env: Record<string, string>) => Configuration };
  return module.builderConfig(env);
}

describe("electron-builder configuration", () => {
  it("names the official app and registers its scheme", async () => {
    const config = await configFor({});
    expect(config).toMatchObject({ appId: "ai.breatic.desktop", productName: "breatic", artifactName: "breatic-${version}-${os}-${arch}.${ext}" });
    expect(config.protocols).toEqual([{ name: "breatic", schemes: ["ai.breatic.desktop"] }]);
    expect(config.linux?.executableName).toBe("breatic");
  });

  it("builds a partner brand under the partner's names", async () => {
    const config = await configFor({ BREATIC_BRAND_DIR: ACME });
    expect(config).toMatchObject({ appId: "com.acme.studio", productName: "Acme Studio", artifactName: "acme-${version}-${os}-${arch}.${ext}" });
    expect(config.protocols).toEqual([{ name: "Acme Studio", schemes: ["com.acme.studio"] }]);
    expect(config.linux?.executableName).toBe("acme");
    expect(config.icon).toBe(join(ACME, "icon.png"));
    expect(config.deb?.desktop?.desktopActions?.NewWindow?.Exec).toBe(`"/opt/Acme Studio/acme" ${NEW_WINDOW_ARG}`);
  });

  it("gives the Debian launcher entry a New Window action in every language", async () => {
    const desktop = (await configFor({})).deb?.desktop;
    expect(desktop?.entry?.Actions).toBe("NewWindow;");
    expect(desktop?.desktopActions?.NewWindow).toEqual({
      Name: desktopText("en", "breatic")["desktop.menu.newWindow"],
      "Name[zh_CN]": desktopText("zh-CN", "breatic")["desktop.menu.newWindow"],
      "Name[zh_TW]": desktopText("zh-TW", "breatic")["desktop.menu.newWindow"],
      "Name[ja]": desktopText("ja", "breatic")["desktop.menu.newWindow"],
      "Name[ko]": desktopText("ko", "breatic")["desktop.menu.newWindow"],
      Exec: `/opt/breatic/breatic ${NEW_WINDOW_ARG}`,
    });
  });

  it("builds the zip macOS updates need beside the dmg", async () => {
    expect((await configFor({})).mac?.target).toEqual([{ target: "dmg", arch: ["arm64", "x64"] }, { target: "zip", arch: ["arm64", "x64"] }]);
  });

  it("writes no update feed without BREATIC_UPDATE_BASE_URL, or with a blank one", async () => {
    for (const env of [{}, { BREATIC_UPDATE_BASE_URL: "  " }] as Record<string, string>[]) {
      const config = await configFor({ ...env, CSC_LINK: "cert", ...SIGNED_WINDOWS });
      expect([config.mac?.publish, config.win?.publish, config.linux?.publish]).toEqual([null, null, null]);
    }
  });

  it("writes the feed under the brand's directory, on macOS and Windows only when signed", async () => {
    const entry = [{ provider: "generic", url: `${FEED}/acme/` }];
    const unsigned = await configFor({ BREATIC_BRAND_DIR: ACME, BREATIC_UPDATE_BASE_URL: FEED });
    expect([unsigned.mac?.publish, unsigned.win?.publish, unsigned.linux?.publish]).toEqual([null, null, entry]);
    const signed = await configFor({ BREATIC_BRAND_DIR: ACME, BREATIC_UPDATE_BASE_URL: `${FEED}/`, CSC_LINK: "cert", ...SIGNED_WINDOWS });
    expect([signed.mac?.publish, signed.win?.publish, signed.linux?.publish]).toEqual([entry, entry, entry]);
  });

  it("writes no Windows feed when the publisher name is missing: installed clients could not check who signed an update", async () => {
    const { AZURE_PUBLISHER_NAME: _name, ...withoutName } = SIGNED_WINDOWS;
    const config = await configFor({ ...withoutName, BREATIC_UPDATE_BASE_URL: FEED });
    expect(config.win?.publish).toBeNull();
  });

  it("names the Windows publisher so an update signed by anyone else is refused", async () => {
    const config = await configFor(SIGNED_WINDOWS);
    expect(config.win?.azureSignOptions?.publisherName).toBe("Orime, Inc.");
  });
});
