// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The grammars a chat code block can be coloured with.
 *
 * These ten are what an agent reply actually carries; a block in any other
 * language, and a block with no language at all, renders as plain monospace.
 *
 * `rehype-highlight` imports lowlight's `common` set at the top of its own
 * module (lib/index.js:3), so all thirty-seven of those grammars reach the
 * bundle whatever is handed to it — the entry chunk of a production build
 * carries ruby, kotlin and objective-c among them.
 *
 * Names are highlight.js's own. Each grammar registers its own aliases, so
 * ```html reaches `xml` and ```ts reaches `typescript` without another entry.
 */
import type { LanguageFn } from 'lowlight';

import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

export const HIGHLIGHT_LANGUAGES: Record<string, LanguageFn> = {
  bash,
  css,
  diff,
  javascript,
  json,
  python,
  sql,
  typescript,
  xml,
  yaml,
};
