// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check } from "#repo-lint/check";
import { eofNewline } from "#repo-lint/checks/eof-newline";
import { eslintRulesEnabled } from "#repo-lint/checks/eslint-rules-enabled";
import { lintCoverage } from "#repo-lint/checks/lint-coverage";
import { migrationStyle } from "#repo-lint/checks/migration-style";
import { noAuthBypassResidue } from "#repo-lint/checks/no-auth-bypass-residue";
import { noBrandUsage } from "#repo-lint/checks/no-brand-usage";
import { noCjk } from "#repo-lint/checks/no-cjk";
import { noDisabledInvariant } from "#repo-lint/checks/no-disabled-invariant";
import { noHardcodedSecrets } from "#repo-lint/checks/no-hardcoded-secrets";
import { noPrivateRepoPath } from "#repo-lint/checks/no-private-repo-path";
import { noSilentSkip } from "#repo-lint/checks/no-silent-skip";
import { noTranslatedProductNoun } from "#repo-lint/checks/no-translated-product-noun";
import { noTrojanSource } from "#repo-lint/checks/no-trojan-source";
import { noUnresolvedAliasInDist } from "#repo-lint/checks/no-unresolved-alias-in-dist";
import { serviceEntriesPresent } from "#repo-lint/checks/service-entries-present";
import { sharedDepsInCatalog } from "#repo-lint/checks/shared-deps-in-catalog";
import { storageKeyPrefixHtml } from "#repo-lint/checks/storage-key-prefix-html";
import { tokenValues } from "#repo-lint/checks/token-values";

/**
 * Every repository-wide check, run as one CI step.
 *
 * These are the invariants ESLint structurally cannot hold: they are about
 * files it never parses (SQL, YAML, shell, build output) or about the
 * repository itself rather than any one file's contents.
 */
export const CHECKS: readonly Check[] = [
  eofNewline,
  eslintRulesEnabled,
  lintCoverage,
  migrationStyle,
  noAuthBypassResidue,
  noBrandUsage,
  noCjk,
  noDisabledInvariant,
  noHardcodedSecrets,
  noPrivateRepoPath,
  noSilentSkip,
  noTranslatedProductNoun,
  noTrojanSource,
  noUnresolvedAliasInDist,
  serviceEntriesPresent,
  sharedDepsInCatalog,
  storageKeyPrefixHtml,
  tokenValues,
];
