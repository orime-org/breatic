// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * eslint-plugin-drizzle, typed: the package ships no type declarations, and
 * every program that imports this package (the root lint, repo-lint, a
 * service elsewhere) must see the same type for it.
 */

import type { TSESLint } from "@typescript-eslint/utils";
// @ts-expect-error eslint-plugin-drizzle ships no type declarations.
import plugin from "eslint-plugin-drizzle";

/** The plugin with the flat-config plugin type. */
export const drizzlePlugin: TSESLint.FlatConfig.Plugin = plugin as TSESLint.FlatConfig.Plugin;
