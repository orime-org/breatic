// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { createProcessMemberRule } from "#rules/process-member-rule";

/**
 * Library packages must not read environment variables.
 *
 * Acquiring configuration is an application decision, the same boundary that
 * keeps loggers and `process.exit` out of libraries. Each service entry is
 * the composition root: it loads dotenv and calls `initCore(process.env)`
 * once, a zod schema validates the result, and libraries read what was
 * injected through the `env` proxy, `getConfig()` or `getRawEnvVar()`.
 *
 * `process.cwd()` is untouched — it is not configuration.
 */
export const noLibraryEnvAccess = createProcessMemberRule({
  name: "no-library-env-access",
  description:
    "Library packages must take configuration through initCore rather than reading process.env",
  member: "env",
  message:
    "Library packages must not read process.env — take configuration through initCore/env instead. The application entry owns configuration acquisition.",
});
