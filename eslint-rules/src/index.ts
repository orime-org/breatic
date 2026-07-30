// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { activeBorder } from "#rules/rules/active-border";
import { hoverPattern } from "#rules/rules/hover-pattern";
import { noCollabAuthPrimitives } from "#rules/rules/no-collab-auth-primitives";
import { noCorsWildcardCredentials } from "#rules/rules/no-cors-wildcard-credentials";
import { noDrizzleTypeLeak } from "#rules/rules/no-drizzle-type-leak";
import { noInlineScrollbar } from "#rules/rules/no-inline-scrollbar";
import { noIoredisOutsideCore } from "#rules/rules/no-ioredis-outside-core";
import { noLibraryEnvAccess } from "#rules/rules/no-library-env-access";
import { noLibraryLogger } from "#rules/rules/no-library-logger";
import { noLibraryProcessExit } from "#rules/rules/no-library-process-exit";
import { noNativeRenderedUi } from "#rules/rules/no-native-rendered-ui";
import { noParamAsString } from "#rules/rules/no-param-as-string";
import { noPostgresOutsideCore } from "#rules/rules/no-postgres-outside-core";
import { noSyncInRequestPath } from "#rules/rules/no-sync-in-request-path";
import { noYjsDocumentsOutsideRepo } from "#rules/rules/no-yjs-documents-outside-repo";
import { onePxBorder } from "#rules/rules/one-px-border";
import { singleToastEntry } from "#rules/rules/single-toast-entry";
import { singleTooltipProvider } from "#rules/rules/single-tooltip-provider";

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
    "active-border": activeBorder,
    "hover-pattern": hoverPattern,
    "no-collab-auth-primitives": noCollabAuthPrimitives,
    "no-cors-wildcard-credentials": noCorsWildcardCredentials,
    "no-drizzle-type-leak": noDrizzleTypeLeak,
    "no-inline-scrollbar": noInlineScrollbar,
    "no-ioredis-outside-core": noIoredisOutsideCore,
    "no-library-env-access": noLibraryEnvAccess,
    "no-library-logger": noLibraryLogger,
    "no-library-process-exit": noLibraryProcessExit,
    "no-native-rendered-ui": noNativeRenderedUi,
    "no-param-as-string": noParamAsString,
    "no-postgres-outside-core": noPostgresOutsideCore,
    "no-sync-in-request-path": noSyncInRequestPath,
    "no-yjs-documents-outside-repo": noYjsDocumentsOutsideRepo,
    "one-px-border": onePxBorder,
    "single-toast-entry": singleToastEntry,
    "single-tooltip-provider": singleTooltipProvider,
  },
} as const;
