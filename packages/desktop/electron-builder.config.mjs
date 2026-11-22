// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Packaging for the desktop client (#1599, design §9). Signing turns on only
 * when its credentials are in the environment, so a build without them is an
 * unsigned build of the same app.
 *
 * macOS: CSC_LINK and CSC_KEY_PASSWORD (Developer ID Application) sign;
 * APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER notarize.
 * Windows: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET plus the
 * Artifact Signing account (AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
 * AZURE_SIGNING_PROFILE) sign the installer.
 */

import en from "../../locales/en.json" with { type: "json" };
import ja from "../../locales/ja.json" with { type: "json" };
import ko from "../../locales/ko.json" with { type: "json" };
import zhCN from "../../locales/zh-CN.json" with { type: "json" };
import zhTW from "../../locales/zh-TW.json" with { type: "json" };

const env = process.env;
const azure = env.AZURE_SIGNING_ENDPOINT && env.AZURE_SIGNING_ACCOUNT && env.AZURE_SIGNING_PROFILE;
const notarize = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);

/** @type {import("electron-builder").Configuration} */
export default {
  appId: "ai.breatic.desktop",
  productName: "breatic",
  copyright: "Copyright © 2026 Orime, Inc.",
  directories: { app: "build/app", output: "release" },
  icon: "../web/public/icon-512.png",
  extraResources: [{ from: "resources/third-party-licences.txt", to: "third-party-licences.txt" }],
  protocols: [{ name: "breatic", schemes: ["breatic"] }],
  artifactName: "breatic-${version}-${os}-${arch}.${ext}",
  // The installers are workflow artifacts; nothing is uploaded from a build.
  publish: null,
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    category: "public.app-category.graphics-design",
    hardenedRuntime: true,
    notarize,
    identity: env.CSC_LINK ? undefined : null,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    ...(azure
      ? {
          azureSignOptions: {
            endpoint: env.AZURE_SIGNING_ENDPOINT,
            codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
            certificateProfileName: env.AZURE_SIGNING_PROFILE,
          },
        }
      : {}),
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  // A right-click on the installed launcher icon opens another window (design §5.1).
  // The AppImage writes its own hidden entry for the scheme and has no launcher icon.
  deb: {
    desktop: {
      entry: { Actions: "NewWindow;" },
      desktopActions: {
        NewWindow: {
          Name: en.desktop.menu.newWindow,
          "Name[zh_CN]": zhCN.desktop.menu.newWindow,
          "Name[zh_TW]": zhTW.desktop.menu.newWindow,
          "Name[ja]": ja.desktop.menu.newWindow,
          "Name[ko]": ko.desktop.menu.newWindow,
          Exec: "/opt/breatic/breatic --new-window",
        },
      },
    },
  },
  linux: {
    target: ["AppImage", "deb"],
    category: "Graphics",
    executableName: "breatic",
    maintainer: "Orime, Inc.",
  },
};
