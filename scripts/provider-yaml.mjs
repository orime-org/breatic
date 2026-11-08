// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How the `scripts/provider-*.ts` generators write `config/provider/` yaml:
 * a string holding a character the repository's no-cjk check refuses (a
 * full-width parenthesis in two MiniMax voice ids) is written double-quoted
 * with that character as a `\uXXXX` escape, as the catalog spells it, so a
 * rerun writes the same bytes (inner#1775).
 */

import { visit } from "yaml";

/** The ranges repo-lint's no-cjk check refuses, within the basic plane. */
const WIDE = "\\u3000-\\u312F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFF00-\\uFFEF";
const HAS_WIDE = new RegExp(`[${WIDE}]`);
const EVERY_WIDE = new RegExp(`[${WIDE}]`, "g");

/**
 * A yaml document as text, every wide character escaped.
 * @param {import("yaml").Document} doc - The document; its scalars holding a wide character are switched to double quotes.
 * @param {import("yaml").ToStringOptions} options - How to write it.
 * @returns {string} The text.
 */
export function yamlText(doc, options) {
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && HAS_WIDE.test(node.value)) node.type = "QUOTE_DOUBLE";
    },
  });
  return doc.toString(options).replace(EVERY_WIDE, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
