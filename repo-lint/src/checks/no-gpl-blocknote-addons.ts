// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * The editor's `xl-` add-ons stay out of the dependency tree.
 *
 * BlockNote ships in two halves. `@blocknote/core` and `@blocknote/react` are
 * MPL-2.0, whose copyleft reaches the files it covers and no further — which
 * is why we take them, and why `THIRD-PARTY.md` records them. Everything under
 * the `@blocknote/xl-` prefix is offered as `GPL-3.0 OR PROPRIETARY`: measured
 * on the registry, all six of `xl-ai`, `xl-multi-column`, and the four
 * exporters say exactly that. Taking one under its GPL half puts the whole
 * front-end bundle under GPL-3.0; taking it under the other half is a purchase.
 *
 * The prefix is how upstream marks that half, so the prefix is what this reads.
 * A name is easier to check than a licence field, which is only present once a
 * package is installed and is written in whatever spelling its author chose.
 *
 * Both places a package can arrive are checked. A manifest declaring one is the
 * obvious way; the lockfile catches the other, where something we do declare
 * depends on it and no manifest of ours ever says the name. The lockfile is
 * read only for names no manifest mentions, so a declared package is reported
 * once, against the file a reader would edit.
 */

/** What upstream prefixes its GPL half with. */
const GPL_PREFIX = "@blocknote/xl-";

/** Finds every `@blocknote/xl-*` name in a blob of text. */
const NAMED = /@blocknote\/xl-[a-z0-9-]+/g;

export const noGplBlocknoteAddons = {
  name: "no-gpl-blocknote-addons",
  description: "No @blocknote/xl-* package, which would put the bundle under GPL-3.0",
  run(context: CheckContext): Finding[] {
    const manifests = context.files(
      (path) =>
        path === "package.json" ||
        /^(packages|eslint-rules|repo-lint)\/[^/]+\/package\.json$/.test(path) ||
        /^(eslint-rules|repo-lint)\/package\.json$/.test(path),
      "package manifests",
    );

    const findings: Finding[] = [];
    const declared = new Set<string>();
    for (const file of manifests) {
      const manifest = JSON.parse(context.read(file)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const section of [manifest.dependencies, manifest.devDependencies]) {
        for (const name of Object.keys(section ?? {})) {
          if (!name.startsWith(GPL_PREFIX)) continue;
          declared.add(name);
          findings.push({
            file,
            message:
              `"${name}" is offered as GPL-3.0 OR PROPRIETARY. Under its GPL-3.0 ` +
              `half every bundle it reaches is GPL-3.0, and the other half is a ` +
              `commercial licence to buy. @blocknote/core and @blocknote/react ` +
              `are MPL-2.0 and carry no such condition; anything under the ` +
              `${GPL_PREFIX} prefix does.`,
          });
        }
      }
    }

    const reached = new Set(context.read("pnpm-lock.yaml").match(NAMED) ?? []);
    for (const name of [...reached].sort()) {
      if (declared.has(name)) continue;
      findings.push({
        file: "pnpm-lock.yaml",
        message:
          `"${name}" is in the dependency tree without any manifest of ours ` +
          `naming it, so something we do declare pulls it in. It is GPL-3.0 OR ` +
          `PROPRIETARY, and it reaches the bundle either way.`,
      });
    }
    return findings;
  },
} satisfies Check;
