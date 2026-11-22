// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every Dockerfile here has instructions taking the overview, the licence and
 * the trademark policy into its image.
 *
 * `THIRD-PARTY.md` names the components worth a reader's attention, the terms
 * each comes under, which half of a dual offer we elected, and where FFmpeg's
 * source is fetched from. `LICENSE` is the licence every copy is received
 * under (section 4(a) of it asks redistributors to pass it on), and
 * `TRADEMARKS.md` the branding rules section 12 points at. The image is the
 * thing that gets distributed, so a copy sitting in the repository reaches
 * nobody who received one.
 *
 * What this reads is the instruction, not the built image: a `COPY` written
 * into a stage that is thrown away would satisfy it. A file `.dockerignore`
 * leaves out of the build context cannot be copied at all, so that is read too.
 */

/** The files every published image has to carry, at the repository root. */
const NOTICES = ["THIRD-PARTY.md", "LICENSE", "TRADEMARKS.md"] as const;

/**
 * Where the Dockerfiles are: a basename of `Dockerfile`, with or without a
 * dotted suffix (`Dockerfile.web`), or ending in `.Dockerfile`
 * (`packages/ingest/web-animation.Dockerfile`).
 */
const DOCKERFILE = /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.Dockerfile)$/;

/**
 * A `COPY` whose source is the named file.
 *
 * Anchored at the start of a line, which is also what keeps prose out: a
 * Dockerfile comment is a whole line beginning with `#`. The flags are optional
 * and unconstrained because they do not change what the instruction does with
 * the file. The trailing boundary is what keeps `THIRD-PARTY.md.bak` from
 * passing as the file asked for.
 * @param file The file's name at the repository root.
 * @returns A pattern for a COPY of it.
 */
function copyOf(file: string): RegExp {
  return new RegExp(String.raw`^\s*COPY\s+(?:--\S+\s+)*(?:\S*/)?${file.replace(".", String.raw`\.`)}\s`, "mi");
}

export const everyDockerfileCopiesTheOverview = {
  name: "every-dockerfile-copies-the-overview",
  description: `Every Dockerfile has a COPY taking ${NOTICES.join(", ")} into its image`,
  run(context: CheckContext): Finding[] {
    // Selected by shape rather than from a list: a Dockerfile added later is
    // covered without anyone remembering to register it.
    const dockerfiles = context.files((path) => DOCKERFILE.test(path), "Dockerfiles");

    const findings: Finding[] = [];
    for (const path of dockerfiles) {
      const text = context.read(path);
      for (const notice of NOTICES.filter((file) => !copyOf(file).test(text))) {
        findings.push({
          file: path,
          message:
            `This image does not carry ${notice}. The image is what gets ` +
            `distributed, so a copy left in the repository reaches nobody who ` +
            `received one. Add a COPY for it: Dockerfile.web puts it in the ` +
            `static root so a browser can fetch it; the others put it at ` +
            `/usr/share/doc/breatic/.`,
        });
      }
    }

    if (context.exists(".dockerignore")) {
      const ignored = new Set(
        context
          .read(".dockerignore")
          .split("\n")
          .map((line) => line.trim().replace(/^\//, "")),
      );
      for (const notice of NOTICES.filter((file) => ignored.has(file))) {
        findings.push({
          file: ".dockerignore",
          message: `.dockerignore leaves ${notice} out of the build context, so no image can COPY it. Remove that line.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
