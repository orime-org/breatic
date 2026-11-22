// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How sign-in links on the build's own scheme reach the client (#1599, design
 * §9.2).
 *
 * macOS delivers them through `open-url`. Windows and Linux start the client
 * with the link as an argument, or hand those arguments to the instance
 * already running. An AppImage installs no desktop entry, so the client writes
 * its own to register the scheme, named after the brand so two brands never
 * overwrite each other's.
 */

/**
 * The link on the build's scheme among a launch's arguments.
 * @param argv - The arguments.
 * @param scheme - The build's scheme.
 * @returns The link, or null when there is none.
 */
export function findDeepLink(argv: readonly string[], scheme: string): string | null {
  return argv.find((arg) => arg.startsWith(`${scheme}://`)) ?? null;
}

/**
 * The desktop entry that registers the build's scheme for an AppImage.
 * @param appImagePath - `process.env.APPIMAGE`, the AppImage's own path.
 * @param brand - The build's product name and scheme.
 * @param brand.productName - The entry's name.
 * @param brand.scheme - The scheme it handles.
 * @returns The `.desktop` file's content.
 */
export function appImageDesktopEntry(appImagePath: string, brand: { productName: string; scheme: string }): string {
  // The Desktop Entry spec quotes Exec arguments and escapes `"` and `\` inside them.
  const quoted = appImagePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${brand.productName}`,
    `Exec="${quoted}" %U`,
    `MimeType=x-scheme-handler/${brand.scheme};`,
    "NoDisplay=true",
    "",
  ].join("\n");
}
