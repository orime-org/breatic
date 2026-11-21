// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How `breatic://` links reach the client (#1599, design §9.2).
 *
 * macOS delivers them through `open-url`. Windows and Linux start the client
 * with the link as an argument, or hand those arguments to the instance
 * already running. An AppImage installs no desktop entry, so the client writes
 * its own to register the scheme.
 */

/** The scheme the client registers. */
export const DEEP_LINK_SCHEME = "breatic";

/**
 * The `breatic://` link among a launch's arguments.
 * @param argv - The arguments.
 * @returns The link, or null when there is none.
 */
export function findDeepLink(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/**
 * The desktop entry that registers the scheme for an AppImage.
 * @param appImagePath - `process.env.APPIMAGE`, the AppImage's own path.
 * @returns The `.desktop` file's content.
 */
export function appImageDesktopEntry(appImagePath: string): string {
  // The Desktop Entry spec quotes Exec arguments and escapes `"` and `\` inside them.
  const quoted = appImagePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=breatic",
    `Exec="${quoted}" %U`,
    `MimeType=x-scheme-handler/${DEEP_LINK_SCHEME};`,
    "NoDisplay=true",
    "",
  ].join("\n");
}
