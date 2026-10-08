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

/** What the config passes: the Worker modules bundled into the service. */
interface Options {
  /** Module names under `packages/ingest/src`, as the container's tsconfig includes them. */
  bundledIngestModules: string[];
}

/** The prefix the container reaches the Worker's modules by. */
const INGEST_PREFIX = "@ingest/";

/**
 * Whether a specifier stays inside Node and this repository.
 * @param specifier The string a module was reached by.
 * @returns True for a `node:` builtin, an `@ingest/` module or a relative path.
 */
function isOwnCode(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith(INGEST_PREFIX) ||
    specifier.startsWith(".")
  );
}

/**
 * The module name an `@ingest/` specifier reaches, without its extension.
 * @param specifier An `@ingest/` specifier.
 * @returns The name, as the tsconfig's include entries give it.
 */
function ingestModule(specifier: string): string {
  return specifier.slice(INGEST_PREFIX.length).replace(/\.(js|ts)$/, "");
}

export const mediaContainerOwnCodeOnly = createRule<[Options], "notOwnCode" | "notBundled">({
  name: "media-container-own-code-only",
  meta: {
    type: "problem",
    docs: {
      description:
        "The media container's service imports only Node builtins and the Worker modules its tsconfig names",
    },
    schema: [
      {
        type: "object",
        properties: {
          bundledIngestModules: { type: "array", items: { type: "string" } },
        },
        required: ["bundledIngestModules"],
        additionalProperties: false,
      },
    ],
    messages: {
      notOwnCode:
        "'{{specifier}}' is not a node: builtin or an @ingest/ module. The media container runs vips and ffmpeg as separate programs (inner#1339), and its service loads no other code into its process.",
      notBundled:
        "'{{specifier}}' is not in packages/ingest/container/tsconfig.json's include. tsc and esbuild follow this import anyway, so the module would be bundled into the media container without this rule reading it: add it to that include.",
    },
  },
  defaultOptions: [{ bundledIngestModules: [] }],
  create(context, [{ bundledIngestModules }]) {
    const bundled = new Set(bundledIngestModules);
    return moduleSourceVisitors(
      (node: TSESTree.Node, source: TSESTree.StringLiteral): void => {
        const specifier = source.value;
        if (!isOwnCode(specifier)) {
          context.report({ node, messageId: "notOwnCode", data: { specifier } });
          return;
        }
        if (specifier.startsWith(INGEST_PREFIX) && !bundled.has(ingestModule(specifier))) {
          context.report({ node, messageId: "notBundled", data: { specifier } });
        }
      },
    );
  },
});
