// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every text file kind a person writes in this repository.
 *
 * One definition rather than one per check. The guards these checks replace
 * each kept their own list, and the lists had drifted apart — which is how a
 * file kind ends up covered by one guard and invisible to the next. A check
 * that genuinely wants a different set states the difference and says why.
 */
export const AUTHORED_TEXT =
  /\.(ts|mts|cts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|css|scss|html|sh|sql)$/;

/**
 * The lockfile, which is machine-authored.
 *
 * Nobody writes prose, a secret or a private path into it deliberately, and
 * it is large enough to slow every scan that reads it.
 */
export const GENERATED = /(^|\/)pnpm-lock\.yaml$/;

/**
 * Test files, which several checks exempt for the same reason.
 *
 * Their content is fixture data rather than something the product ships, so
 * a rule about what ships does not reach them.
 */
export const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.(ts|tsx)$/;
