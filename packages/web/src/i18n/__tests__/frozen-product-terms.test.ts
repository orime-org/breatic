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
  // Project-invite role labels (key name is edit/view, semantics editor/viewer).
  ['share.role.edit', 'Editor'],
  ['share.role.view', 'Viewer'],
  // Entity + space-type nouns — Title Case English.
  ['studio.container.tabs.projects', 'Projects'],
  ['studio.container.tabs.collections', 'Collections'],
  ['studio.container.collections.title', 'Collections'],
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

  /**
   * Collision-noun keys (#1340): Canvas / Document / Timeline / Space have a
   * translated form that collides with a genuine common word that legitimately
   * stays localized (画布 = drawing surface, 文件/文档 = a file, 時間軸/タイムライン
   * = the video-editor track, スペース/스페이스 = a Workspace substring), so they
   * cannot go in the blanket lint:no-translated-product-noun denylist. They are
   * frozen per-key here instead: each space-type / entity key must CONTAIN the
   * English term inside its (still-translated) sentence and NOT contain any of
   * the localized noun forms. The blanket forms (Project / Collection / Work /
   * Studio / Space's 工作面·作業面) are owned by the lint guard.
   */
  const CANVAS_FORMS = ['画布', '畫布', 'キャンバス', '캔버스'];
  const DOCUMENT_FORMS = ['文档', '文檔', '文件', 'ドキュメント', '문서'];
  const TIMELINE_FORMS = ['时间线', '時間線', '時間軸', '时间轴', 'タイムライン', '타임라인'];
  const SPACE_FORMS = ['工作面', '作業面', 'スペース', '스페이스', '작업면'];

  /** Each collision key paired with its English term + the localized forms that must be absent. */
  const COLLISION_FROZEN: ReadonlyArray<
    readonly [key: string, term: string, forbidden: readonly string[]]
  > = [
    ['spaces.drawer.new_canvas', 'Canvas', CANVAS_FORMS],
    ['spaces.readonly.canvas.title', 'Canvas', CANVAS_FORMS],
    ['spaces.tab.new', 'Canvas', CANVAS_FORMS],
    ['spaces.tab.drawer', 'Canvas', CANVAS_FORMS],
    ['spaces.drawer.new_document', 'Document', DOCUMENT_FORMS],
    ['spaces.readonly.document.title', 'Document', DOCUMENT_FORMS],
    ['spaces.drawer.new_timeline', 'Timeline', TIMELINE_FORMS],
    ['spaces.readonly.timeline.title', 'Timeline', TIMELINE_FORMS],
    ['spaces.readonly.timeline.description', 'Timeline', TIMELINE_FORMS],
    ['chrome.tooltip.newSpace', 'Space', SPACE_FORMS],
    ['chrome.tooltip.allSpaces', 'Space', SPACE_FORMS],
    ['project.space.noActive', 'Space', SPACE_FORMS],
    ['spaces.create.title', 'Space', SPACE_FORMS],
  ];

  // The freeze applies to the four non-English locales; en is the source and
  // keeps its own casual lowercase common words ("New canvas", "personal
  // studio"), so the collision + lowercase-studio assertions skip it.
  const NON_EN_CATALOGS = LOCALE_CATALOGS.filter(([locale]) => locale !== 'en');

  describe('collision-noun keys frozen per-key in every non-English locale', () => {
    for (const [locale] of NON_EN_CATALOGS) {
      for (const [key, term, forbidden] of COLLISION_FROZEN) {
        it(`${locale}: ${key} keeps "${term}" English`, () => {
          setLocale(locale);
          const value = t(key);
          expect(value).toContain(term);
          for (const form of forbidden) expect(value).not.toContain(form);
        });
      }
    }
  });

  /**
   * Role-name collision keys (#1337 sentence freeze): most role-name
   * translations are collision-free and owned by the blanket
   * lint:no-translated-product-noun denylist (所有者 / 编辑者 / 管理员 / …). A
   * few translated role forms collide with a legitimate word, so they cannot
   * go in the blanket guard and are frozen per-key here instead:
   *   - Editor: the Editor *tool* feature stays エディター / 에디터, so only the
   *     role-only kanji/hangul (編集者 / 편집자) is denied; the role uses in
   *     these keys must not reintroduce the tool's katakana/hangul form.
   *   - Viewer: ko 뷰어 also names the read-only viewer plugin.
   *   - Creator: ja/ko クリエイター / 크리에이터 doubles as the generic word.
   * `t(key)` with no args returns the raw ICU message, so the select-branch
   * literals (editor {Editor} …) are asserted directly on the raw string.
   */
  const EDITOR_COLLISION = ['エディタ', 'エディター', '에디터'];
  const VIEWER_COLLISION = ['뷰어'];
  const CREATOR_COLLISION = ['クリエイター', '크리에이터'];
  // Member: 成员 / 成員 / メンバー / 멤버 all double as the generic "member count"
  // word, so the blanket guard cannot deny them; the role-label spots are frozen
  // per-key here. (Generic count usages like "成员 (5)" / "移除成员" stay localized.)
  const MEMBER_COLLISION = ['成员', '成員', 'メンバー', '멤버'];

  /** Each role-collision key paired with its English term + the localized forms that must be absent. */
  const ROLE_COLLISION_FROZEN: ReadonlyArray<
    readonly [key: string, term: string, forbidden: readonly string[]]
  > = [
    // Bell "invited as …" subtitles.
    ['notifications.subtitle.invitedAsCreator', 'Creator', CREATOR_COLLISION],
    ['notifications.subtitle.invitedAsEditor', 'Editor', EDITOR_COLLISION],
    // Studio member-action menu.
    ['studio.container.members.promoteToCreator', 'Creator', CREATOR_COLLISION],
    // Invite-confirm ICU bodies (raw message asserts the frozen branch literal).
    ['studio.invite.body', 'Creator', CREATOR_COLLISION],
    ['projectInvite.body', 'Editor', EDITOR_COLLISION],
    ['projectInvite.body', 'Viewer', VIEWER_COLLISION],
    // Member role-label spots (sibling to invitedAsCreator/Editor/Viewer etc.).
    ['notifications.subtitle.invitedAsMember', 'Member', MEMBER_COLLISION],
    ['studio.container.members.demoteToMember', 'Member', MEMBER_COLLISION],
    ['studio.invite.body', 'Member', MEMBER_COLLISION],
    ['projectInvite.body', 'Member', MEMBER_COLLISION],
  ];

  describe('role-collision keys frozen per-key in every non-English locale', () => {
    for (const [locale] of NON_EN_CATALOGS) {
      for (const [key, term, forbidden] of ROLE_COLLISION_FROZEN) {
        it(`${locale}: ${key} keeps "${term}" English`, () => {
          setLocale(locale);
          const value = t(key);
          expect(value).toContain(term);
          for (const form of forbidden) expect(value).not.toContain(form);
        });
      }
    }
  });

  /**
   * Lowercase-English "studio" that names the Studio entity (not the ICU
   * {studio} placeholder, not a /studio/ URL) is capitalized to the frozen
   * brand term. These four server / dialog strings carried a bare lowercase
   * "studio"; after the freeze they must read "Studio".
   */
  const LOWERCASE_STUDIO_KEYS: readonly string[] = [
    'server.studio.team_limit_reached',
    'server.studio.cannot_modify_personal',
    'studio.container.members.cannotInvitePersonal',
    'studio.container.dialog.createStudioError',
  ];

  describe('lowercase studio entity capitalized to Studio in every non-English locale', () => {
    for (const [locale] of NON_EN_CATALOGS) {
      for (const key of LOWERCASE_STUDIO_KEYS) {
        it(`${locale}: ${key} reads "Studio" not lowercase "studio"`, () => {
          setLocale(locale);
          const value = t(key);
          expect(value).toContain('Studio');
          expect(value).not.toMatch(/\bstudio\b/);
        });
      }
    }
  });
});
