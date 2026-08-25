// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { createProcessMemberRule } from "#rules/process-member-rule";

/**
 * Library packages must not end the process.
 *
 * A library knows something went wrong but not whether the process should
 * die: exiting `server` means a permanent 503, exiting `worker` cuts the
 * BullMQ retry chain, exiting `collab` drops every live editing session.
 * Only the application entry owns that decision, so libraries throw a typed
 * error and let the entry catch, log the context, and exit.
 *
 * The known boundary — a destructured binding or a trip through `globalThis`
 * is not flagged — is documented once on the factory this shares with the
 * environment rule, so closing it later closes it for both.
 */
export const noLibraryProcessExit = createProcessMemberRule({
  name: "no-library-process-exit",
  description:
    "Library packages must throw a typed error instead of ending the process",
  member: "exit",
  message:
    "Library packages must not call process.exit — throw a typed error and let the application entry decide whether to exit.",
});
