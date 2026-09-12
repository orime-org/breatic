// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { FFMPEG_BINDING_WORDS } from "@breatic/eslint-rules";
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * FFmpeg's libraries stay out of our process (#178, action 1).
 *
 * We run ffmpeg as a separate program: ten call sites, every one of them a
 * subprocess — eight `spawnCollected` in the worker's video mini-tools, two
 * `execFile` in the media container. That is what lets us take a GPL binary
 * without the licence reaching our own code, and it holds only while nothing
 * links the libraries in. In JavaScript there is one way to link a native
 * library: install a package that binds it, then import it. Both ends are
 * text, and between this check and its ESLint half every place that text can
 * be is read.
 *
 * This reads the two places a dependency is declared: a manifest of ours, and
 * the lockfile, where something we do declare pulls a binding in and no
 * manifest of ours ever says the name — the same case
 * `no-gpl-blocknote-addons` reads the lockfile for.
 *
 * The third place is an import of ours, and that one is `eslint-rules`'
 * `no-ffmpeg-bindings`. Telling an import from the same words in a comment, a
 * spawn argument or a test fixture's string needs an AST: these words appear
 * in hundreds of lines of this repository — this docstring among them — and
 * not one of those lines is an import. Matching the text rather than the
 * specifier would report every one of them.
 *
 * What it does not catch: a binding whose name carries none of these words.
 * `beamcoder` is one. The backstop for that is the human licence review the
 * collaboration spec requires of every new dependency; nothing automated here
 * sees it, because a wrapper's declared licence is written by its author and
 * says whatever they chose.
 */

/**
 * The words an ffmpeg binding's package name carries, from the ESLint half.
 *
 * Re-exported so a test can hold the two halves to one list rather than to
 * two that look alike today.
 */
export const BINDING_WORDS = FFMPEG_BINDING_WORDS;

/**
 * Package names in a lockfile's resolution keys.
 *
 * The optional quote is not cosmetic: pnpm quotes every scoped key and leaves
 * unscoped ones bare, and measured on this repository's lockfile that is 1645
 * quoted against 2658 bare. Anchoring straight at the name skips all 1645,
 * which is the shape `@ffmpeg/ffmpeg` and `@ffmpeg/core` arrive in.
 */
const LOCKED = /^\s{2}'?(@?[a-z0-9][^@\s']*)@/gm;

/** The manifest keys pnpm installs from. */
const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

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
      const manifest = JSON.parse(context.read(file)) as Partial<
        Record<(typeof SECTIONS)[number], Record<string, string>>
      >;
      for (const section of SECTIONS) {
        for (const name of Object.keys(manifest[section] ?? {})) {
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
