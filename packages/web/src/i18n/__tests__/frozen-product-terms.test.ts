// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetLocales, setLocale, setLocaleMessages, t } from '@breatic/shared';

import en from '../../../../../locales/en.json';
import zhCN from '../../../../../locales/zh-CN.json';
import zhTW from '../../../../../locales/zh-TW.json';
import ja from '../../../../../locales/ja.json';
import ko from '../../../../../locales/ko.json';

/**
 * Frozen product terms (#1336): a fixed set of product vocabulary that must
 * render as the SAME English string in every locale — roles as Title Case
 * (Owner / Editor / Viewer / Admin / Creator / Member), entity + space-type
 * nouns as Title Case (Studio / Project / Space / Canvas / Document /
 * Timeline). These are deliberate brand-vocabulary terms, never localized.
 *
 * The catalog is duplicated across several key namespaces (role.* /
 * badge.role* / recent.role.* / members.role* / share.role.*); freezing every
 * copy to the same English value also removes the pre-existing zh-CN drift
 * (e.g. role.editor='编辑' vs badge.roleEditor='编辑者').
 */
const LOCALE_CATALOGS = [
  ['en', en],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['ko', ko],
] as const;

/** Each frozen i18n key paired with its required English value (all locales). */
const FROZEN_TERMS: ReadonlyArray<readonly [string, string]> = [
  // Project roles — Title Case English.
  ['role.owner', 'Owner'],
  ['role.editor', 'Editor'],
  ['role.viewer', 'Viewer'],
  // Studio container badge (project/collection cards).
  ['studio.container.badge.roleOwner', 'Owner'],
  ['studio.container.badge.roleEditor', 'Editor'],
  ['studio.container.badge.roleViewer', 'Viewer'],
  // Recent landing card badge.
  ['studio.recent.role.owner', 'Owner'],
  ['studio.recent.role.editor', 'Editor'],
  ['studio.recent.role.viewer', 'Viewer'],
  // Studio member roles.
  ['studio.container.members.roleAdmin', 'Admin'],
  ['studio.container.members.roleCreator', 'Creator'],
  ['studio.container.members.roleMember', 'Member'],
  // Share-link role labels (key name is edit/view, semantics editor/viewer).
  ['share.role.edit', 'Editor'],
  ['share.role.view', 'Viewer'],
  // Entity + space-type nouns — Title Case English.
  ['studio.container.tabs.projects', 'Projects'],
  ['studio.container.dialog.studioLabel', 'Studio'],
  ['spaces.kind.canvas', 'Canvas'],
  ['spaces.kind.document', 'Document'],
  ['spaces.kind.timeline', 'Timeline'],
];

/** Zero-consumer dead keys removed as part of #1336 (decision A). */
const REMOVED_DEAD_KEYS: readonly string[] = [
  'studio.container.projects.title',
  'spaces.tab.kind_canvas',
  'spaces.tab.kind_document',
  'spaces.tab.kind_timeline',
];

/**
 * Resolve a dotted key path against a parsed locale object.
 * @param catalog - Parsed locale JSON.
 * @param path - Dotted key path (e.g. `studio.container.badge.roleOwner`).
 * @returns The value at the path, or undefined if any segment is missing.
 */
function readPath(catalog: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, seg) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      catalog,
    );
}

describe('frozen product terms (#1336)', () => {
  beforeEach(() => {
    resetLocales();
    for (const [locale, catalog] of LOCALE_CATALOGS) {
      setLocaleMessages(locale, catalog as Record<string, unknown>);
    }
    setLocale('en');
  });

  afterEach(() => {
    setLocale('en');
  });

  describe('render as fixed English Title Case in every locale', () => {
    for (const [locale] of LOCALE_CATALOGS) {
      for (const [key, value] of FROZEN_TERMS) {
        it(`${locale}: ${key} → "${value}"`, () => {
          setLocale(locale);
          expect(t(key)).toBe(value);
        });
      }
    }
  });

  describe('dead keys removed from every locale', () => {
    for (const [locale, catalog] of LOCALE_CATALOGS) {
      for (const key of REMOVED_DEAD_KEYS) {
        it(`${locale}: ${key} absent`, () => {
          expect(readPath(catalog, key)).toBeUndefined();
        });
      }
    }
  });
});
