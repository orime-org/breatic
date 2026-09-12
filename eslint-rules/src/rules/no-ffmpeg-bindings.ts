// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { moduleSourceVisitors } from "#rules/source-visitors";

/**
 * FFmpeg's libraries stay out of our process (#178, action 1).
 *
 * We run ffmpeg as a separate program — every call site spawns it — and that
 * is what keeps a GPL binary's licence off our own code. Importing a package
 * that binds its libraries makes them part of this process instead.
 *
 * The judge is the module specifier, which only an AST can tell from the same
 * words in a comment, a spawn argument or a test fixture's string. Those words
 * appear in hundreds of lines of this repository — this docstring among them —
 * and not one of those lines is an import.
 *
 * The dependency side of the same rule is `repo-lint`'s
 * `no-ffmpeg-binding-deps`, which reads manifests and the lockfile — a package
 * can be installed and loaded by its parent without any import of ours.
 */

/**
 * The words an ffmpeg binding's package name carries.
 *
 * Exported because `repo-lint`'s `no-ffmpeg-binding-deps` asks the same
 * question of the same names from the other side, and two copies of a list
 * that grows is one copy going stale.
 */
export const FFMPEG_BINDING_WORDS = [
  "ffmpeg",
  "libav",
  "avcodec",
  "avformat",
  "avfilter",
  "swscale",
  "swresample",
];

/**
 * Whether a module specifier names an ffmpeg binding.
 *
 * A relative path and a subpath import (`#rules/...`) both resolve inside this
 * repository, so neither can carry a native library.
 * @param specifier The string a module was reached by.
 * @returns True when it is a bare package name carrying a binding word.
 */
function isBinding(specifier: string): boolean {
  if (/^[./#]/.test(specifier)) return false;
  const lower = specifier.toLowerCase();
  return FFMPEG_BINDING_WORDS.some((word) => lower.includes(word));
}

export const noFfmpegBindings = createRule<[], "noBinding">({
  name: "no-ffmpeg-bindings",
  meta: {
    type: "problem",
    docs: {
      description: "No package that binds FFmpeg's libraries into our process",
    },
    schema: [],
    messages: {
      noBinding:
        "'{{specifier}}' binds FFmpeg's libraries into this process. ffmpeg is invoked as a subprocess (#178, action 1), which is what keeps the GPL binary a separate program from our code.",
    },
  },
  defaultOptions: [],
  create(context) {
    return moduleSourceVisitors(
      (node: TSESTree.Node, source: TSESTree.StringLiteral): void => {
        if (!isBinding(source.value)) return;
        context.report({
          node,
          messageId: "noBinding",
          data: { specifier: source.value },
        });
      },
    );
  },
});
