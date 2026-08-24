// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { createForbiddenTokenRule } from "#rules/forbidden-token-rule";

/**
 * collab must authenticate through core, not by hand.
 *
 * It once read the session key and the membership table itself, which meant
 * two implementations of the same authorization decision — and they drifted.
 * Reaching for the session key prefix or the members table from collab is
 * the signal that it is happening again.
 */
export const noCollabAuthPrimitives = createForbiddenTokenRule({
  name: "no-collab-auth-primitives",
  description: "collab authenticates through core rather than by hand",
  tokens: ["project_members", ":session:"],
  message:
    "collab must not reach {{token}} directly — go through core's getSession / loadProjectRole, so one authorization decision has one implementation.",
});
