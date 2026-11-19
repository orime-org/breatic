// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lint rules a backend service package is held to, as flat-config blocks
 * for the packages a caller names. The product's root config applies them to
 * `packages/server`; a service that builds on the product's libraries in
 * another repository applies the same blocks to its own package, so both are
 * held to one rule set. Each rule's reason is in its own documentation; the
 * root `eslint.config.ts` carries the history of each choice.
 */

import type { TSESLint } from "@typescript-eslint/utils";
import drizzle from "eslint-plugin-drizzle";
import jsdoc from "eslint-plugin-jsdoc";
import { breaticPlugin, upstreamLiteralOptions } from "#rules/index";

/** What {@link backendConfig} needs from its caller. */
export interface BackendConfigOptions {
  /** Each service package's directory, relative to the config's root (`packages/server`). */
  packages: readonly string[];
  /** The repository root `config/provider/upstreams.yaml` is read from, for `no-upstream-literal`. */
  rootDir: string;
}

const TEST_IGNORES = ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"];
const TEST_IGNORES_TSX = ["**/__tests__/**", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"];

/**
 * The backend service rule blocks for the given packages.
 * @param options - The packages and the repository root.
 * @returns Flat-config blocks; the caller spreads them into its config.
 */
export function backendConfig(options: BackendConfigOptions): TSESLint.FlatConfig.Config[] {
  const dirs = options.packages;
  /**
   * One glob per package.
   * @param suffix - The part after the package directory.
   * @returns The globs.
   */
  const each = (suffix: string): string[] => dirs.map((dir) => `${dir}/${suffix}`);
  const jsdocTs = jsdoc.configs["flat/recommended-typescript-error"];
  const src = each("src/**/*.ts");
  const srcTsx = each("src/**/*.{ts,tsx}");
  const anyTsx = each("**/*.{ts,tsx}");

  return [
    { files: [...anyTsx, ...each("src/**/*.{mts,cts}")], plugins: { breatic: breaticPlugin } },
    {
      files: srcTsx,
      ignores: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/__tests__/**"],
      plugins: jsdocTs.plugins,
      rules: {
        ...jsdocTs.rules,
        "jsdoc/require-jsdoc": [
          "error",
          {
            publicOnly: false,
            require: {
              ArrowFunctionExpression: false,
              ClassDeclaration: true,
              ClassExpression: true,
              FunctionDeclaration: true,
              FunctionExpression: false,
              MethodDefinition: true,
            },
            contexts: [
              "VariableDeclarator > ArrowFunctionExpression",
              "VariableDeclarator > FunctionExpression",
              "PropertyDefinition > ArrowFunctionExpression",
              "PropertyDefinition > FunctionExpression",
            ],
          },
        ],
        "jsdoc/require-description": "error",
        "jsdoc/require-throws-type": "error",
        "jsdoc/require-yields-type": "off",
        "jsdoc/require-next-type": "off",
        "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      },
    },
    {
      files: src,
      plugins: { drizzle },
      rules: {
        "drizzle/enforce-delete-with-where": ["error", { drizzleObjectName: ["db", "tx"] }],
        "drizzle/enforce-update-with-where": ["error", { drizzleObjectName: ["db", "tx"] }],
      },
    },
    {
      files: srcTsx,
      ignores: TEST_IGNORES,
      rules: {
        "breatic/no-postgres-outside-core": "error",
        "breatic/no-ioredis-outside-core": "error",
      },
    },
    { files: each("src/**/*.{ts,tsx,mts,cts}"), rules: { "breatic/no-ffmpeg-bindings": "error" } },
    {
      files: anyTsx,
      ignores: ["**/*.repo.ts", ...TEST_IGNORES_TSX],
      rules: { "breatic/no-drizzle-type-leak": "error" },
    },
    {
      files: anyTsx,
      ignores: TEST_IGNORES_TSX,
      rules: {
        "breatic/no-param-as-string": "error",
        "breatic/no-cors-wildcard-credentials": "error",
      },
    },
    {
      files: src,
      ignores: [...TEST_IGNORES, "**/config/**", "**/config.ts", "**/infra/**", "**/*-loader.ts", "**/model-catalog/**"],
      rules: { "breatic/no-sync-in-request-path": "error" },
    },
    { files: srcTsx, ignores: TEST_IGNORES_TSX, rules: { "breatic/no-yjs-documents-outside-repo": "error" } },
    {
      files: src,
      ignores: ["**/*.repo.ts", "packages/*/src/db/**", "**/connectivity-check.ts", ...TEST_IGNORES],
      rules: { "breatic/no-raw-sql-outside-repo": "error" },
    },
    {
      files: anyTsx,
      ignores: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/__tests__/**"],
      rules: { "breatic/doc-link-resolves": "error" },
    },
    { files: each("src/modules/**/*.ts"), ignores: TEST_IGNORES, rules: { "breatic/no-hardcoded-request-ttl": "error" } },
    { files: src, ignores: TEST_IGNORES, rules: { "breatic/no-raw-body-parse": "error" } },
    { files: src, ignores: TEST_IGNORES, rules: { "breatic/no-untranslated-error-message": "error" } },
    { files: each("src/**/*.{test,spec}.{ts,tsx}"), rules: { "breatic/test-file-location": "error" } },
    { files: srcTsx, rules: { "breatic/no-missing-license-header": "error" } },
    { files: srcTsx, ignores: TEST_IGNORES_TSX, rules: { "breatic/no-relative-import": "error" } },
    { files: each("src/index.ts"), rules: { "breatic/service-observability": "error" } },
    { files: src, ignores: TEST_IGNORES, rules: { "breatic/schema-timestamps": "error" } },
    { files: srcTsx, rules: { "breatic/no-deployed-host": "error" } },
    { files: srcTsx, ignores: TEST_IGNORES, rules: { "breatic/no-naked-fetch": "error" } },
    {
      files: srcTsx,
      ignores: TEST_IGNORES,
      rules: { "breatic/no-upstream-literal": ["error", upstreamLiteralOptions(options.rootDir)] },
    },
  ];
}
