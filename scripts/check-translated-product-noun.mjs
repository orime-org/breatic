// check-translated-product-noun — scanner half of lint:no-translated-product-noun.
//
// Enforces the product-term "do-not-translate" glossary (see
// packages/web/CLAUDE.md "产品术语「不翻译表」"): 8 product entity / type nouns
// plus the role names are brand vocabulary kept in English across every locale,
// even inside translated sentences. This guard scans the VALUES of the four
// non-English locale catalogs and fails if any UNAMBIGUOUS translated form of a
// frozen term survives — so a future translator (or a new string) reintroducing
// the localized word is caught at CI.
//
// Why only "unambiguous" forms here: some translated forms collide with a
// genuine common word that legitimately stays localized — Canvas's form is also
// the drawing surface, Timeline's form is also the video-editor track,
// Document's form is also "a file", and the ja/ko Space form is a substring of
// the word for Workspace. The same collision applies to a few role forms: the
// Editor tool feature stays as エディター / 에디터 (so those katakana/hangul
// forms can't be denied — only the role-only kanji 編集者 / 編輯者 / 编辑者 and
// hangul 편집자 are), the ko Viewer form 뷰어 also names the read-only viewer
// plugin, and ja/ko Creator's role-label form クリエイター / 크리에이터 doubles
// as the generic word "creator". A blanket denylist on those would
// false-positive, so they are enforced per-key by
// packages/web/src/i18n/__tests__/frozen-product-terms.test.ts instead. This
// blanket guard covers only the collision-free forms, which must NEVER appear.
//
// Scanner only — exit 1 on violation. Invoked by
// scripts/lint-no-translated-product-noun.sh / `pnpm lint:no-translated-product-noun`.
// Implemented in Node (not grep) to scan parsed JSON string values only — never
// key names or ICU `{placeholder}` tokens — and to sidestep the BSD-grep
// multibyte character-class locale trap.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, '..', 'locales');
const LOCALES = ['zh-CN', 'zh-TW', 'ja', 'ko'];

// Unambiguous translated forms of frozen nouns — these have no legitimate
// common-word survivor, so they must NEVER appear in any locale value.
const DENY = {
  Project: ['项目', '專案', 'プロジェクト', '프로젝트'],
  Collection: ['资产集', '資產集', 'コレクション', 'アセット集', '컬렉션'],
  Work: ['作品', '작품'],
  Studio: ['工作室', 'スタジオ', '스튜디오'],
  // Space: only the distinctive forms; the katakana / hangul forms are a
  // Workspace substring and are enforced per-key by frozen-product-terms.test.
  Space: ['工作面', '作業面'],
  // Role names — collision-free forms only (see header). The Editor tool
  // (エディター / 에디터), ko Viewer (뷰어), and ja/ko Creator role-label form
  // (クリエイター / 크리에이터) collide with legitimate words and are frozen
  // per-key in frozen-product-terms.test instead.
  Owner: ['所有者', '拥有者', '擁有者', 'オーナー', '소유자'],
  Editor: ['编辑者', '編輯者', '編集者', '편집자'],
  Viewer: ['观察者', '查看者', '觀察者', '檢視者', 'ビューア', 'ビューワー', '閲覧者', '열람자'],
  Admin: ['管理员', '管理員', '管理者', '관리자'],
  Creator: ['创建者', '創建者', '建立者', '作成者', '작성자', '생성자'],
};

/**
 * Flatten a nested locale catalog to dotted keyPath → string value.
 * @param {unknown} obj - Parsed locale JSON (object tree).
 * @param {string} prefix - Accumulated dotted prefix.
 * @param {Record<string, string>} out - Accumulator of leaf string values.
 * @returns {Record<string, string>} every leaf string value keyed by its dotted path.
 */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, p, out);
    else if (typeof v === 'string') out[p] = v;
  }
  return out;
}

const violations = [];
for (const locale of LOCALES) {
  const catalog = JSON.parse(readFileSync(resolve(localesDir, `${locale}.json`), 'utf8'));
  const flat = flatten(catalog);
  for (const [keyPath, value] of Object.entries(flat)) {
    for (const [noun, forms] of Object.entries(DENY)) {
      for (const form of forms) {
        if (value.includes(form)) {
          violations.push({ locale, keyPath, noun, form, value });
        }
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    'lint:no-translated-product-noun — frozen product nouns must stay English in every locale:\n\n',
  );
  for (const v of violations) {
    process.stderr.write(
      `  ${v.locale}  ${v.keyPath}  →  "${v.form}" (${v.noun}) in: ${v.value}\n`,
    );
  }
  process.stderr.write(
    `\n${violations.length} violation(s). These nouns are brand vocabulary (do-not-translate):\n` +
      'replace the translated word with the English term, matching the en.json source form\n' +
      '(singular/plural). See packages/web/CLAUDE.md "产品术语「不翻译表」".\n',
  );
  process.exit(1);
}

process.stdout.write(
  'lint:no-translated-product-noun — clean (no translated product nouns in any locale)\n',
);
