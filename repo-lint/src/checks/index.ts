// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check } from "#repo-lint/check";
import { docLinks } from "#repo-lint/checks/doc-links";
import { eofNewline } from "#repo-lint/checks/eof-newline";
import { lintCoverage } from "#repo-lint/checks/lint-coverage";
import { migrationStyle } from "#repo-lint/checks/migration-style";
import { noAuthBypassResidue } from "#repo-lint/checks/no-auth-bypass-residue";
import { noBrandUsage } from "#repo-lint/checks/no-brand-usage";
import { noCjk } from "#repo-lint/checks/no-cjk";
import { noHardcodedSecrets } from "#repo-lint/checks/no-hardcoded-secrets";
import { noNotificationNameKeys } from "#repo-lint/checks/no-notification-name-keys";
import { noPrivateRepoPath } from "#repo-lint/checks/no-private-repo-path";
import { noTranslatedProductNoun } from "#repo-lint/checks/no-translated-product-noun";
import { serviceEntriesPresent } from "#repo-lint/checks/service-entries-present";
import { tokenValues } from "#repo-lint/checks/token-values";
import { storageKeyPrefixHtml } from "#repo-lint/checks/storage-key-prefix-html";
import { noUnresolvedAliasInDist } from "#repo-lint/checks/no-unresolved-alias-in-dist";
import { noTrojanSource } from "#repo-lint/checks/no-trojan-source";

/**
 * Every repository-wide check, run as one CI step.
 *
 * These are the invariants ESLint structurally cannot hold: they are about
 * files it never parses (SQL, YAML, shell, build output) or about the
 * repository itself rather than any one file's contents.
 */
export const CHECKS: readonly Check[] = [
  docLinks,
  eofNewline,
  lintCoverage,
  migrationStyle,
  noAuthBypassResidue,
  noBrandUsage,
  noCjk,
  noHardcodedSecrets,
  noNotificationNameKeys,
  noPrivateRepoPath,
  noTranslatedProductNoun,
  noTrojanSource,
  noUnresolvedAliasInDist,
  serviceEntriesPresent,
  storageKeyPrefixHtml,
  tokenValues,
];
