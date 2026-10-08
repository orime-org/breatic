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
 * Our own packages are reached by their aliases (`@ingest/`, `@shared/`), and
 * each one the service reaches must be named in the container's tsconfig, so
 * this rule reads it too.
 *
 * The service ships as one bundled file with no `node_modules`, so an import
 * is the only way anything gets into it, and the specifier is all there is to
 * judge.
 */

/** What the config passes: this repository's modules bundled into the service. */
interface Options {
  /** Each as its alias and path without extension, e.g. `@ingest/jobs/op-args`, as the container's tsconfig includes them. */
  bundledModules: string[];
}

/** The aliases the container reaches this repository's modules by: the Worker's own, and the shared package. */
const REPO_PREFIXES = ["@ingest/", "@shared/"] as const;

/**
 * Whether a specifier reaches one of this repository's packages by its alias.
 * @param specifier The string a module was reached by.
 * @returns True for an `@ingest/` or `@shared/` specifier.
 */
function isRepoAlias(specifier: string): boolean {
  return REPO_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/**
 * Whether a specifier stays inside Node and this repository.
 * @param specifier The string a module was reached by.
 * @returns True for a `node:` builtin, a repository alias or a relative path.
 */
function isOwnCode(specifier: string): boolean {
  return specifier.startsWith("node:") || isRepoAlias(specifier) || specifier.startsWith(".");
}

export const mediaContainerOwnCodeOnly = createRule<[Options], "notOwnCode" | "notBundled">({
  name: "media-container-own-code-only",
  meta: {
    type: "problem",
    docs: {
      description:
        "The media container's service imports only Node builtins and the repository modules its tsconfig names",
    },
    schema: [
      {
        type: "object",
        properties: {
          bundledModules: { type: "array", items: { type: "string" } },
        },
        required: ["bundledModules"],
        additionalProperties: false,
      },
    ],
    messages: {
      notOwnCode:
        "'{{specifier}}' is not a node: builtin or an @ingest/ or @shared/ module. The media container runs vips and ffmpeg as separate programs (inner#1339), and its service loads no other code into its process.",
      notBundled:
        "'{{specifier}}' is not in packages/ingest/container/tsconfig.json's include. tsc and esbuild follow this import anyway, so the module would be bundled into the media container without this rule reading it: add it to that include.",
    },
  },
  defaultOptions: [{ bundledModules: [] }],
  create(context, [{ bundledModules }]) {
    const bundled = new Set(bundledModules);
    return moduleSourceVisitors(
      (node: TSESTree.Node, source: TSESTree.StringLiteral): void => {
        const specifier = source.value;
        if (!isOwnCode(specifier)) {
          context.report({ node, messageId: "notOwnCode", data: { specifier } });
          return;
        }
        if (isRepoAlias(specifier) && !bundled.has(specifier.replace(/\.(js|ts)$/, ""))) {
          context.report({ node, messageId: "notBundled", data: { specifier } });
        }
      },
    );
  },
});
