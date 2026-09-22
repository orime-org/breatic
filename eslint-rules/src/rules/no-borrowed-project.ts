// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { createForbiddenTokenRule } from "#rules/forbidden-token-rule";

/**
 * A test never helps itself to a Project somebody else made.
 *
 * Two routes did this, and both describe the same assumption: a Project is
 * already there. Clicking the first `/project/` link on the studio page
 * takes whatever that account happens to own, and reading a URL out of the
 * environment takes whatever was written down once. Either way the test
 * passes on one machine and reports a defect on the next, and the report
 * points at the product rather than at the missing Project.
 *
 * Setup now creates the Projects a run needs and hands them over by
 * account, so a test asks for the one it was given. That also ends the
 * pile-up the first route caused: everything landed in one long-lived
 * Project, which grew to 826 Spaces on one measured account.
 *
 * Both routes are a name appearing in source, which is the shape the shared
 * token factory exists for.
 */
export const noBorrowedProject = createForbiddenTokenRule({
  name: "no-borrowed-project",
  description: "A test opens the Project setup gave it, not one it found",
  tokens: ['href^="/project/"', "SMOKE_PROJECT_URL"],
  message:
    "'{{token}}' reaches for a Project the test did not create. Ask the project helper for the one setup prepared for this account.",
});
