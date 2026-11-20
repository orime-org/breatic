// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lint rules a backend service package is held to, as flat-config blocks
 * for the packages a caller names. The product's root config applies them to
 * `packages/server`; a service that builds on the product's libraries in
 * another repository applies the same blocks to its own package, so both are
 * held to one rule set. Each rule's reason is in its own documentation; the
 * root `eslint.config.ts` carries the history of the choices it applies
 * itself; the reasons for the two rules only service packages carry sit
 * beside them below.
 */

import type { TSESLint } from "@typescript-eslint/utils";
import jsdoc from "eslint-plugin-jsdoc";
import { drizzlePlugin } from "#rules/drizzle-plugin";
import { breaticPlugin, upstreamLiteralOptions } from "#rules/index";

/** What {@link backendConfig} needs from its caller. */
export interface BackendConfigOptions {
  /** Each service package's directory, relative to the config's root (`packages/server`). */
  packages: readonly string[];
  /** The repository root `config/provider/upstreams.yaml` is read from, for `no-upstream-literal`. */
  rootDir: string;
  /** The two header lines every source file opens with, where they are not this repository's AGPL lines. */
  licenseHeader?: { copyright: string; licence: string };
}

// eslint-plugin-jsdoc TypeScript preset (error level): enforces TSDoc-style
// doc comments. no-types stays on (TS already provides param/return/yield
// types — the codebase has 0 inline-type comments). The ONE exception is
// require-throws-type, kept ON in FUNCTION_FORMAT_RULES: exception types are the single piece of
// type info a TS signature CANNOT carry (no checked exceptions), so they live
// in the comment as `@throws {ErrorType}`. yields/next-type stay off (the
// Generator<Y,R,N> signature carries them, same as returns). Together with
// explicit-function-return-type, this realizes the function-definition format
// spec (docs/ARCHITECTURE.md → Coding standards): type info → signature; exception type →
// comment. Replaces eslint-plugin-tsdoc's all-or-nothing tsdoc/syntax warn (#850).
const jsdocTs = jsdoc.configs["flat/recommended-typescript-error"];

/** The function-definition format: every named function unit has a doc block and a return type. */
export const FUNCTION_FORMAT_PLUGINS = jsdocTs.plugins;

/** The rules of the function-definition format (docs/ARCHITECTURE.md, coding standards). */
export const FUNCTION_FORMAT_RULES: TSESLint.FlatConfig.Rules = {
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
  // Every doc block must carry a one-line summary description, not just
  // tags — a bare @param/@returns block is incomplete (a rule is either
  // 0 or 1; the summary is not an optional carve-out). The #850 cleanup added
  // summaries everywhere, so this holds at zero violations.
  "jsdoc/require-description": "error",
  // Exception type → comment (signature can't carry it). The braces in
  // `@throws {AppError}` are the one place a type belongs in a doc tag.
  "jsdoc/require-throws-type": "error",
  // Generator yield/next types are carried by the Generator<Y,R,N>
  // signature, same as a return type — not duplicated in the comment.
  "jsdoc/require-yields-type": "off",
  "jsdoc/require-next-type": "off",
  // Every named function unit declares its return type in the signature;
  // generators write Generator<Y,R,N>. allowExpressions exempts inline
  // anonymous callbacks (arr.map(x => x*2), event handlers), mirroring the
  // require-jsdoc carve-out for non-named-unit functions.
  "@typescript-eslint/explicit-function-return-type": [
    "error",
    { allowExpressions: true },
  ],
};

/** A delete or update with no where clause rewrites the whole table; db and tx are the handles we use. */
export const DRIZZLE_WHERE_RULES: TSESLint.FlatConfig.Rules = {
  "drizzle/enforce-delete-with-where": [
    "error",
    { drizzleObjectName: ["db", "tx"] },
  ],
  "drizzle/enforce-update-with-where": [
    "error",
    { drizzleObjectName: ["db", "tx"] },
  ],
};

/** Paths that run before traffic arrives, where synchronous reads are allowed. */
export const SYNC_IN_REQUEST_PATH_IGNORES = [
  "**/__tests__/**",
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/config/**",
  "**/config.ts",
  "**/infra/**",
  "**/*-loader.ts",
  "**/model-catalog/**",
];

const TEST_IGNORES = ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"];

/** Where SQL may be written outside a repository: repositories, the database setup and the startup probe. */
export const RAW_SQL_OUTSIDE_REPO_IGNORES = ["**/*.repo.ts", "packages/*/src/db/**", "**/connectivity-check.ts", ...TEST_IGNORES];
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
  const src = each("src/**/*.ts");
  const srcTsx = each("src/**/*.{ts,tsx}");
  const anyTsx = each("**/*.{ts,tsx}");

  return [
    { files: [...anyTsx, ...each("src/**/*.{mts,cts}")], plugins: { breatic: breaticPlugin } },
    {
      files: srcTsx,
      ignores: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/__tests__/**"],
      plugins: FUNCTION_FORMAT_PLUGINS,
      rules: FUNCTION_FORMAT_RULES,
    },
    {
      files: src,
      plugins: { drizzle: drizzlePlugin },
      rules: DRIZZLE_WHERE_RULES,
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
      ignores: SYNC_IN_REQUEST_PATH_IGNORES,
      rules: { "breatic/no-sync-in-request-path": "error" },
    },
    { files: srcTsx, ignores: TEST_IGNORES_TSX, rules: { "breatic/no-yjs-documents-outside-repo": "error" } },
    { files: src, ignores: RAW_SQL_OUTSIDE_REPO_IGNORES, rules: { "breatic/no-raw-sql-outside-repo": "error" } },
    {
      files: anyTsx,
      ignores: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/__tests__/**"],
      rules: { "breatic/doc-link-resolves": "error" },
    },
    // Where the five deferred decisions live (studio invite, project invite,
    // studio transfer, project transfer, role upgrade). Their shared TTL is
    // config/limits.yaml -> deferred_request_ttl_days, reached through
    // deferredRequestExpiry(), which lives in src/config outside this glob.
    // Session lifetime is out of scope: a 30-day session is a different
    // concept that happens to be measured in days. Tests are exempt because
    // they construct deliberately expired instants to verify the expiry gate.
    { files: each("src/modules/**/*.ts"), ignores: TEST_IGNORES, rules: { "breatic/no-hardcoded-request-ttl": "error" } },
    // Routes hand their body to `validate`; they never parse it themselves. A
    // bare ZodError or SyntaxError from a hand-parsed body is not an AppError,
    // so it falls past the error handler's typed branches and answers 500 for
    // a request the caller simply got wrong. The whole package, because reading
    // a parsed body outside the one wrapper is wrong wherever it is written.
    // `req.text()` stays allowed: a Stripe signature is computed over the bytes
    // as sent. Tests are exempt: they build requests rather than handle them.
    { files: src, ignores: TEST_IGNORES, rules: { "breatic/no-raw-body-parse": "error" } },
    { files: src, ignores: TEST_IGNORES, rules: { "breatic/no-untranslated-error-message": "error" } },
    { files: each("src/**/*.{test,spec}.{ts,tsx}"), rules: { "breatic/test-file-location": "error" } },
    {
      files: srcTsx,
      rules: { "breatic/no-missing-license-header": options.licenseHeader === undefined ? "error" : ["error", options.licenseHeader] },
    },
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
