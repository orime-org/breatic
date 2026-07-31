// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { CheckContext } from "#repo-lint/check";

/**
 * Every allowlisted path still exists.
 *
 * An exemption is a decision about one file, and it stops being about
 * anything the moment that file is renamed or deleted. What is left is an
 * entry that matches nothing, waves through whatever lands on that path
 * next, and reads to the next person as though it were still doing its job.
 * Fifteen such entries were found dead across seven of the shell guards this
 * suite replaced, so this is the observed failure rather than a precaution.
 *
 * Refusing rather than reporting: an allowlist that has come loose from the
 * tree is not a finding about the repository, it is this check no longer
 * knowing what it is exempting.
 * @param context The check context.
 * @param allowed Paths to their stated reasons.
 * @throws {Error} When an allowlisted file no longer exists.
 */
export function assertAllowlistIsLive(
  context: CheckContext,
  allowed: ReadonlyMap<string, string>,
): void {
  for (const [path, reason] of allowed) {
    if (context.exists(path)) continue;
    throw new Error(
      `${path} is allowlisted here — "${reason}" — but no such file exists. An exemption outliving its file waves through whatever lands on that path next; remove the entry or fix the path.`,
    );
  }
}
