// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check } from "#repo-lint/check";
import { eofNewline } from "#repo-lint/checks/eof-newline";
import { noTrojanSource } from "#repo-lint/checks/no-trojan-source";

/**
 * Every repository-wide check, run as one CI step.
 *
 * These are the invariants ESLint structurally cannot hold: they are about
 * files it never parses (SQL, YAML, shell, build output) or about the
 * repository itself rather than any one file's contents.
 */
export const CHECKS: readonly Check[] = [eofNewline, noTrojanSource];
