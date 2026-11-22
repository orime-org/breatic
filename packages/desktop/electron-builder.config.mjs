// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Packaging for the desktop client (#1599, design §9). Every name comes from
 * the brand the build is for (brand.mjs). Signing turns on only when its
 * credentials are in the environment, so a build without them is an unsigned
 * build of the same app.
 *
 * macOS: CSC_LINK and CSC_KEY_PASSWORD (Developer ID Application) sign;
 * APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER notarize.
 * Windows: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET plus the
 * Artifact Signing account (AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
 * AZURE_SIGNING_PROFILE) sign the installer; AZURE_PUBLISHER_NAME is the
 * certificate's subject, which installed clients require of every update.
 *
 * Updates (design §9.1.2): BREATIC_UPDATE_BASE_URL turns the feed on, under
 * one directory per brand. macOS and Windows get it only when signed:
 * Squirrel.Mac cannot install an unsigned update, and an unsigned Windows
 * build has no publisher to check updates against.
 */

import en from "../../locales/en.json" with { type: "json" };
import ja from "../../locales/ja.json" with { type: "json" };
import ko from "../../locales/ko.json" with { type: "json" };
import zhCN from "../../locales/zh-CN.json" with { type: "json" };
import zhTW from "../../locales/zh-TW.json" with { type: "json" };
import { currentBrand } from "./brand.mjs";

/**
 * electron-builder's configuration for an environment.
 * @param {Record<string, string | undefined>} env - The environment the build runs in.
 * @returns {import("electron-builder").Configuration} The configuration.
 */
export function builderConfig(env) {
  const brand = currentBrand(env);
  const azure = Boolean(env.AZURE_SIGNING_ENDPOINT && env.AZURE_SIGNING_ACCOUNT && env.AZURE_SIGNING_PROFILE);
  const notarize = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
  const base = env.BREATIC_UPDATE_BASE_URL?.trim().replace(/\/+$/, "");
  const feed = base ? [{ provider: "generic", url: `${base}/${brand.id}/` }] : null;
  const newWindow = (locale) => locale.desktop.menu.newWindow;
  return {
    appId: brand.appId,
    productName: brand.productName,
    copyright: "Copyright © 2026 Orime, Inc.",
    directories: { app: "build/app", output: "release" },
    icon: brand.icon,
    extraResources: [{ from: "resources/third-party-licences.txt", to: "third-party-licences.txt" }],
    protocols: [{ name: brand.productName, schemes: [brand.scheme] }],
    artifactName: brand.artifactName,
    publish: null,
    mac: {
      target: [
        { target: "dmg", arch: ["arm64", "x64"] },
        { target: "zip", arch: ["arm64", "x64"] },
      ],
      category: "public.app-category.graphics-design",
      hardenedRuntime: true,
      notarize,
      identity: env.CSC_LINK ? undefined : null,
      publish: env.CSC_LINK ? feed : null,
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      ...(azure
        ? {
            azureSignOptions: {
              endpoint: env.AZURE_SIGNING_ENDPOINT,
              codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
              certificateProfileName: env.AZURE_SIGNING_PROFILE,
              publisherName: env.AZURE_PUBLISHER_NAME,
            },
          }
        : {}),
      publish: azure ? feed : null,
    },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
    // A right-click on the installed launcher icon opens another window (design §5.1).
    // The AppImage writes its own hidden entry for the scheme and has no launcher icon.
    deb: {
      desktop: {
        entry: { Actions: "NewWindow;" },
        desktopActions: {
          NewWindow: {
            Name: newWindow(en),
            "Name[zh_CN]": newWindow(zhCN),
            "Name[zh_TW]": newWindow(zhTW),
            "Name[ja]": newWindow(ja),
            "Name[ko]": newWindow(ko),
            Exec: brand.newWindowExec,
          },
        },
      },
    },
    linux: {
      target: ["AppImage", "deb"],
      category: "Graphics",
      executableName: brand.executableName,
      maintainer: "Orime, Inc.",
      publish: feed,
    },
  };
}

export default builderConfig(process.env);
