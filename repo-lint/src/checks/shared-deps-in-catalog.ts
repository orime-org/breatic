// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/** A dependency declaration found in one package manifest. */
interface Declaration {
  /** Repo-relative path of the manifest it was found in. */
  readonly file: string;
  /** The range as written — `catalog:` when it defers to the catalog. */
  readonly range: string;
}

/**
 * A dependency more than one package needs is declared in the catalog, once.
 *
 * The failure this exists to stop is not dramatic, which is why it went
 * unnoticed for so long: every manifest is its own source of truth, so nothing
 * says whether the version one package asks for is the version another package
 * gets. Left alone it drifts silently. At the point the catalog was introduced
 * `@types/node` had spread across four major versions, `@tiptap/*` was declared
 * at `^3.22.3` while the collaboration caret pulled 3.27.3, and eslint really
 * did install both 9 and 10 side by side.
 *
 * Moving those into `pnpm-workspace.yaml`'s catalog fixed the versions that had
 * already drifted, and fixing them is a one-off — the next dependency two
 * packages happen to share starts the same drift over. So the rule is about the
 * shape rather than any list of names: a package shared by two or more manifests
 * must say `catalog:` in every one of them. Nothing to keep up to date, and a
 * new shared dependency is caught the day it becomes shared.
 *
 * A package only one manifest declares is left alone. There is no second
 * declaration for it to disagree with, and forcing single-consumer dependencies
 * through a workspace-wide catalog would put every package's private choices in
 * one file for no benefit.
 *
 * `workspace:` ranges are internal packages, which resolve to the checkout and
 * have no version to drift.
 */
export const sharedDepsInCatalog = {
  name: "shared-deps-in-catalog",
  description: "Dependencies shared by two or more packages defer to the catalog",
  run(context: CheckContext): Finding[] {
    const manifests = context.files(
      (path) =>
        path === "package.json" ||
        /^(packages|eslint-rules|repo-lint)\/[^/]+\/package\.json$/.test(path) ||
        /^(eslint-rules|repo-lint)\/package\.json$/.test(path),
      "package manifests",
    );

    // name -> every place it is declared, so a finding can name the siblings
    // the reader has to reconcile it with.
    const declarations = new Map<string, Declaration[]>();
    for (const file of manifests) {
      const manifest = JSON.parse(context.read(file)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const section of [manifest.dependencies, manifest.devDependencies]) {
        for (const [name, range] of Object.entries(section ?? {})) {
          if (range.startsWith("workspace:")) continue;
          const found = declarations.get(name) ?? [];
          found.push({ file, range });
          declarations.set(name, found);
        }
      }
    }

    const findings: Finding[] = [];
    for (const [name, found] of [...declarations].sort()) {
      if (found.length < 2) continue;
      const pinned = found.filter((d) => d.range !== "catalog:");
      if (pinned.length === 0) continue;
      const others = found
        .filter((d) => !pinned.includes(d))
        .map((d) => d.file);
      for (const declaration of pinned) {
        const elsewhere = found
          .filter((d) => d !== declaration)
          .map((d) => `${d.file} (${d.range})`)
          .join(", ");
        findings.push({
          file: declaration.file,
          message:
            `"${name}": "${declaration.range}" is also declared in ${elsewhere}. ` +
            `A dependency two packages share must read "catalog:" in both, with the ` +
            `version in pnpm-workspace.yaml — otherwise the two drift apart with ` +
            `nothing to notice.` +
            (others.length > 0
              ? ` (${others.length} of them already do.)`
              : ""),
        });
      }
    }
    return findings;
  },
} satisfies Check;
