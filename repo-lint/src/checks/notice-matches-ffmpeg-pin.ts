// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * The Dockerfile's ffmpeg pin and the notice's entry name one version.
 *
 * GPL-2 §3 asks for the source of the binary actually distributed, and
 * `THIRD-PARTY.md` answers that with a version and two addresses for it. Both
 * are literals in files nothing else reads together, so they drift the first
 * time a security update lands: the Dockerfile gets bumped, and the notice
 * goes on offering source for a binary no image carries.
 *
 * The other image reads its version out of the package database while it is
 * built (`packages/ingest/Dockerfile`), so that half cannot drift and is not
 * read here.
 */

/** The Dockerfile the `breatic` image is built from. */
const DOCKERFILE = "Dockerfile";

/** The notice that names the version we distribute. */
const NOTICE = "THIRD-PARTY.md";

/** The entry heading whose table holds that version. */
const ENTRY = "### FFmpeg in the `breatic` image";

/** A line naming ffmpeg as a package, with the version it pins if any. */
const INSTALLED = /(?:^|\s)ffmpeg(?:=(\S+?))?(?:\s|\\|$)/;

/** The version in the entry's table, in backticks on the Version row. */
const STATED = /^\|\s*Version\s*\|\s*`([^`]+)`/m;

/**
 * The ffmpeg the Dockerfile installs, read off the line that installs it.
 *
 * Comments are skipped: the real file explains above the `RUN` what ffmpeg is
 * there for, so a scan over the whole text finds that sentence — which names
 * no version — and calls a pinned install unpinned.
 * @param dockerfile - The whole Dockerfile.
 * @returns The version it pins, null when it installs ffmpeg unpinned, and
 *   undefined when it installs no ffmpeg at all.
 */
function pinnedVersion(dockerfile: string): string | null | undefined {
  for (const line of dockerfile.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const found = INSTALLED.exec(line);
    if (found) return found[1] ?? null;
  }
  return undefined;
}

/**
 * The version the entry states.
 * @param notice - The whole notice.
 * @returns The version, or undefined when the entry states none.
 */
function versionInNotice(notice: string): string | undefined {
  const start = notice.indexOf(ENTRY);
  if (start === -1) return undefined;
  return STATED.exec(notice.slice(start))?.[1];
}

export const noticeMatchesFfmpegPin = {
  name: "notice-matches-ffmpeg-pin",
  description: `${DOCKERFILE}'s ffmpeg pin is the version ${NOTICE} names`,
  run(context: CheckContext): Finding[] {
    const pinned = pinnedVersion(context.read(DOCKERFILE));
    const stated = versionInNotice(context.read(NOTICE));

    if (pinned === undefined || pinned === null) {
      return [
        {
          file: DOCKERFILE,
          message:
            pinned === undefined
              ? `No line here installs ffmpeg, while "${ENTRY}" in ${NOTICE} ` +
                `says this image carries it. One of the two is describing an ` +
                `image that no longer exists.`
              : `ffmpeg is installed without a pin, so a rebuild ships ` +
                `whatever bookworm offers that day while ${NOTICE} offers ` +
                `source for one named version. Pin it to the version the ` +
                `notice states.`,
        },
      ];
    }
    if (stated === undefined) {
      return [
        {
          file: NOTICE,
          message:
            `"${ENTRY}" states no version, so nothing says which binary the ` +
            `source addresses below it are for. ${DOCKERFILE} pins ${pinned}.`,
        },
      ];
    }
    if (stated === pinned) return [];

    return [
      {
        file: NOTICE,
        message:
          `${DOCKERFILE} pins ffmpeg ${pinned} and this file states ` +
          `${stated}. GPL-2 §3 asks for the source of the binary we actually ` +
          `distribute, so the two have to be the same version.`,
      },
    ];
  },
} satisfies Check;
