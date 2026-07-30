// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Translations of product nouns that must never appear in a locale.
 *
 * The product's entity names are brand vocabulary and stay English in every
 * language, inside translated sentences included — the same convention as
 * Figma's "Frame", GitHub's "Repository" and Notion's "Database". A
 * non-English UI showing a different word for Project in each screen is the
 * failure this prevents, and it arrives one new string at a time.
 *
 * Only collision-free forms are listed. A word that also means something
 * ordinary — Canvas's form is also the drawing surface, Timeline's is also
 * the video track, Document's is also "a file", and Space's katakana and
 * hangul forms are substrings of Workspace — cannot be banned outright and
 * is frozen per key by the web package's frozen-product-terms test instead.
 * This list is the blanket half: forms with no legitimate survivor, so every
 * future key is covered without anyone remembering to add it.
 *
 * This is the one file in the repository allowed to hold these words, and
 * the no-cjk check names it explicitly: a denylist cannot be written
 * without the words it denies.
 */
export const TRANSLATED_PRODUCT_NOUNS: ReadonlyMap<string, readonly string[]> =
  new Map([
    ["Project", ["项目", "專案", "プロジェクト", "프로젝트"]],
    ["Collection", ["资产集", "資產集", "コレクション", "アセット集", "컬렉션"]],
    ["Work", ["作品", "작품"]],
    ["Studio", ["工作室", "スタジオ", "스튜디오"]],
    ["Space", ["工作面", "作業面"]],
    ["Owner", ["所有者", "拥有者", "擁有者", "オーナー", "소유자"]],
    ["Editor", ["编辑者", "編輯者", "編集者", "편집자"]],
    [
      "Viewer",
      [
        "观察者",
        "查看者",
        "觀察者",
        "檢視者",
        "ビューア",
        "ビューワー",
        "閲覧者",
        "열람자",
      ],
    ],
    ["Admin", ["管理员", "管理員", "管理者", "관리자"]],
    ["Creator", ["创建者", "創建者", "建立者", "作成者", "작성자", "생성자"]],
  ]);
