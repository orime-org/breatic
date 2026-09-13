// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every image we publish carries the overview of what it distributes.
 *
 * `THIRD-PARTY.md` names the components worth a reader's attention, the terms
 * each comes under, which half of a dual offer we elected, and where FFmpeg's
 * source is fetched from. The image is the thing that gets distributed, so a
 * copy sitting in the repository reaches nobody who received one.
 *
 * Measured when this went in: of the three Dockerfiles here, one copied it and
 * two did not. Nothing said so — a missing `COPY` builds a perfectly good image.
 */

/** The file every published image has to carry, at the repository root. */
const OVERVIEW = "THIRD-PARTY.md";

/** Where the Dockerfiles are. Any path whose basename starts this way. */
const DOCKERFILE = /(^|\/)Dockerfile(\.[^/]+)?$/;

/**
 * A `COPY` whose source is the overview itself.
 *
 * Anchored at the start of a line, which is also what keeps prose out: a
 * Dockerfile comment is a whole line beginning with `#`, and all three of this
 * repository's Dockerfiles discuss `THIRD-PARTY.md` in prose — the FFmpeg
 * entries explain which version the file names and why.
 *
 * The flags are optional and unconstrained because they do not change what the
 * instruction does with the file: `--chown` and `--chmod` set what lands, and
 * `--from` takes it out of an earlier stage, which still puts it in the image
 * that ships. The trailing boundary is what keeps `THIRD-PARTY.md.bak` from
 * passing as the file the notice asks for.
 */
const COPIES_IT = new RegExp(
  String.raw`^\s*COPY\s+(?:--\S+\s+)*(?:\S*/)?${OVERVIEW.replace(".", String.raw`\.`)}\s`,
  "mi",
);

/**
 * Whether a Dockerfile puts the overview into the image it builds.
 * @param dockerfile - The file's contents.
 * @returns True when an instruction copies the overview in.
 */
export function copiesTheOverview(dockerfile: string): boolean {
  return COPIES_IT.test(dockerfile);
}

export const overviewTravelsWithEveryImage = {
  name: "overview-travels-with-every-image",
  description: `Every Dockerfile copies ${OVERVIEW} into the image it builds`,
  run(context: CheckContext): Finding[] {
    // Selected by shape rather than from a list of the three that exist today:
    // a Dockerfile added later is covered without anyone remembering to
    // register it, which is the difference between a rule and an inventory.
    const dockerfiles = context.files(
      (path) => DOCKERFILE.test(path),
      "Dockerfiles",
    );

    return dockerfiles
      .filter((path) => !copiesTheOverview(context.read(path)))
      .map((path) => ({
        file: path,
        message:
          `This image does not carry ${OVERVIEW}. The image is what gets ` +
          `distributed, and the overview names what is inside it and under ` +
          `what terms, so a copy left in the repository reaches nobody who ` +
          `received one. Add: COPY ${OVERVIEW} /usr/share/doc/breatic/${OVERVIEW}`,
      }));
  },
} satisfies Check;
