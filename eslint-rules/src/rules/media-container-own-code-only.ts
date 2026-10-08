// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";
import { moduleSourceVisitors } from "#rules/source-visitors";

/**
 * The media container's service loads nothing but Node and our own code.
 *
 * The image's `vips` links two GPL libraries (libimagequant, fftw) and its
 * `ffmpeg` is a GPL build. Both are used as separate programs the service
 * spawns, and that is what keeps their licence off our code (inner#1339). A
 * package imported here would put a third party's code in the service's own
 * process, and a binding (`sharp`, `wasm-vips`, `fluent-ffmpeg`) would put one
 * of those libraries there.
 *
 * The service ships as one bundled file with no `node_modules`, so an import
 * is the only way anything gets into it, and the specifier is all there is to
 * judge.
 */

/**
 * Whether a specifier stays inside Node and this repository.
 * @param specifier The string a module was reached by.
 * @returns True for a `node:` builtin, an `@ingest/` module or a relative path.
 */
function isOwnCode(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("@ingest/") ||
    specifier.startsWith(".")
  );
}

export const mediaContainerOwnCodeOnly = createRule<[], "notOwnCode">({
  name: "media-container-own-code-only",
  meta: {
    type: "problem",
    docs: {
      description:
        "The media container's service imports only Node builtins and our own modules",
    },
    schema: [],
    messages: {
      notOwnCode:
        "'{{specifier}}' is not a node: builtin or an @ingest/ module. The media container runs vips and ffmpeg as separate programs (inner#1339), and its service loads no other code into its process.",
    },
  },
  defaultOptions: [],
  create(context) {
    return moduleSourceVisitors(
      (node: TSESTree.Node, source: TSESTree.StringLiteral): void => {
        if (isOwnCode(source.value)) return;
        context.report({
          node,
          messageId: "notOwnCode",
          data: { specifier: source.value },
        });
      },
    );
  },
});
