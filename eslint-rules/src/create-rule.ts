// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { ESLintUtils } from "@typescript-eslint/utils";

/**
 * Factory shared by every repository-invariant rule in this package.
 *
 * Each guard gets its own rule id on purpose. The built-in
 * `no-restricted-syntax` / `no-restricted-imports` rules hold many unrelated
 * constraints under a single id, and flat config replaces a rule's options
 * wholesale rather than merging them — so two guards sharing one id silently
 * drop whichever was configured first. One guard, one id, no collision.
 */
export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/orime-org/breatic/blob/main/eslint-rules/src/rules/${name}.ts`,
);
