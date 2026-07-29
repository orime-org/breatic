// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { noLibraryEnvAccess } from "#rules/rules/no-library-env-access";
import { noLibraryLogger } from "#rules/rules/no-library-logger";
import { noLibraryProcessExit } from "#rules/rules/no-library-process-exit";

/**
 * The repository's own ESLint plugin.
 *
 * One entry per repository invariant, each under its own rule id. Both the
 * root config and the web package's separate config import this same object,
 * so a rule cannot silently exist on one side and not the other — the two
 * configs previously restated shared rules by hand.
 */
export const breaticPlugin = {
  meta: { name: "@breatic/eslint-rules", version: "0.1.0" },
  rules: {
    "no-library-env-access": noLibraryEnvAccess,
    "no-library-logger": noLibraryLogger,
    "no-library-process-exit": noLibraryProcessExit,
  },
} as const;
