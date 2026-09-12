// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * FFmpeg's libraries stay out of our process (#178, action 1).
 *
 * We run ffmpeg as a separate program: eleven call sites, every one of them a
 * subprocess. That is what lets us take a GPL binary without the licence
 * reaching our own code, and it holds only while nothing links the libraries
 * in. In JavaScript there is one way to link a native library: install a
 * package that binds it, then import it. Both ends are text, and this reads
 * all three places that text can be.
 *
 * This reads the two places a dependency is declared: a manifest of ours, and
 * the lockfile, where something we do declare pulls a binding in and no
 * manifest of ours ever says the name — the same shape `no-gpl-blocknote-addons`
 * reads the lockfile for.
 *
 * The third place is an import of ours, and that one is `eslint-rules`'
 * `no-ffmpeg-bindings`. Telling an import from the same words in a comment, a
 * spawn argument or a test fixture's string needs an AST: measured on this
 * repository, 172 lines mention ffmpeg, ffprobe or libav and none of them is
 * an import.
 *
 * What it does not catch: a binding whose name carries none of these words.
 * `beamcoder` is one. The backstop for that is the human licence review the
 * collaboration spec requires of every new dependency; nothing automated here
 * sees it, because a wrapper's declared licence is written by its author and
 * says whatever they chose.
 */

/** The words an ffmpeg binding's package name carries. */
const BINDING_WORDS = [
  "ffmpeg",
  "libav",
  "avcodec",
  "avformat",
  "avfilter",
  "swscale",
  "swresample",
];

/** Package names in a lockfile's resolution keys. */
const LOCKED = /^\s{2}(@?[a-z0-9][^@\s]*)@/gm;

/**
 * Whether a package name belongs to an ffmpeg binding.
 * @param name - The package name, as declared or as imported.
 * @returns True when the name carries one of the binding words.
 */
function isBinding(name: string): boolean {
  const lower = name.toLowerCase();
  return BINDING_WORDS.some((word) => lower.includes(word));
}

/** What every finding says the rule is. */
const RULE =
  "ffmpeg is invoked as a subprocess and its libraries stay out of our " +
  "process (#178, action 1). Taking a binding makes it a linked library, " +
  "and the GPL binary's licence then reaches our own code.";

export const noFfmpegBindingDeps = {
  name: "no-ffmpeg-binding-deps",
  description: "No dependency that binds FFmpeg's libraries into our process",
  run(context: CheckContext): Finding[] {
    const findings: Finding[] = [];
    const declared = new Set<string>();

    const manifests = context.files(
      (path) => path === "package.json" || path.endsWith("/package.json"),
      "package manifests",
    );
    for (const file of manifests) {
      const manifest = JSON.parse(context.read(file)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const section of [manifest.dependencies, manifest.devDependencies]) {
        for (const name of Object.keys(section ?? {})) {
          if (!isBinding(name)) continue;
          declared.add(name);
          findings.push({ file, message: `"${name}" is declared here. ${RULE}` });
        }
      }
    }

    const lock = context.read("pnpm-lock.yaml");
    const reached = new Set<string>();
    for (const match of lock.matchAll(LOCKED)) {
      const name = match[1] ?? "";
      if (isBinding(name)) reached.add(name);
    }
    for (const name of [...reached].sort()) {
      if (declared.has(name)) continue;
      findings.push({
        file: "pnpm-lock.yaml",
        message:
          `"${name}" is in the dependency tree without any manifest of ours ` +
          `naming it, so something we do declare pulls it in. ${RULE}`,
      });
    }

    return findings;
  },
} satisfies Check;
