// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Markdown into the body's HTML, formulas included (inner#1423 design 6.6).
 *
 * BlockNote's own Markdown reader knows no formulas, and its escapes and
 * emphasis scan would reach into a source (`\{`, `a_1 b_2`). The formulas are
 * found first by remark with the chat's semantics (`MarkdownMessage.tsx`:
 * `$$` only, a lone `$` is a character, nothing inside code), each is swapped
 * for an element carrying only its index, BlockNote reads the rest, and the
 * sources go back into those elements, where the two formula nodes' parse
 * rules read them.
 *
 * A block placeholder stands on a line of its own between empty lines:
 * BlockNote ends a raw HTML block only at an empty line and does not end a
 * paragraph at one (`markdownToHtml.ts:1071-1100`). Inside a quote or a list
 * the empty lines carry the container's prefix, so the formula stays in it.
 */

import { markdownToHTML } from '@blocknote/core';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { formulaSourceHolder, MATH_BLOCK_SOURCE_ATTR, MATH_SOURCE_ATTR } from '@web/lib/formula-source';
import { TEX_ANNOTATION } from '@web/spaces/document/document-math';

/** The placeholder attribute of an inline formula. */
const INLINE_REF = 'data-math-ref';

/** The placeholder attribute of a block formula. */
const BLOCK_REF = 'data-math-block-ref';

/** A node of the Markdown tree, as far as the formula walk reads one. */
interface MdNode {
  readonly type: string;
  readonly value?: string;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  readonly children?: readonly MdNode[];
}

/** A formula found in the Markdown. */
interface Found {
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly block: boolean;
}

/** The reader: GFM plus `$$` formulas, a lone `$` left alone. */
const reader = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false });

/**
 * Every formula in a Markdown tree, in document order.
 * @param node - The node to walk.
 * @param inCell - Whether it sits in a GFM table cell.
 * @param found - Where the formulas go.
 */
function collect(node: MdNode, inCell: boolean, found: Found[]): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if ((node.type === 'math' || node.type === 'inlineMath') && start !== undefined && end !== undefined) {
    // GFM splits a row at every unescaped `|` before it reads a cell, so a
    // formula in a cell carries its bars as `\|`; mdast-util-gfm-table takes
    // the backslash off only for inline code.
    // An empty inline formula is written `$$  $$`, since `$$$$` reads as words.
    const value = node.type === 'inlineMath' && (node.value ?? '').trim() === '' ? '' : node.value ?? '';
    found.push({ start, end, source: inCell ? value.replace(/\\\|/g, '|') : value, block: node.type === 'math' });
    return;
  }
  for (const child of node.children ?? []) collect(child, inCell || node.type === 'tableCell', found);
}

/**
 * The block placeholder with the empty lines around it, written for the
 * container the formula sits in.
 * @param markdown - The whole Markdown.
 * @param at - Where the formula starts.
 * @param index - The formula's index.
 * @returns The text to put in the formula's place.
 */
function blockPlaceholder(markdown: string, at: number, index: number): string {
  const prefix = markdown.slice(markdown.lastIndexOf('\n', at - 1) + 1, at);
  // A quote's `>` carries on every line; a list marker's width carries on as spaces.
  const carry = prefix.replace(/[^\s>]/g, ' ');
  const empty = carry.trimEnd();
  const element = `<div ${BLOCK_REF}="${String(index)}"></div>`;
  // After a list marker the placeholder is the item's first line; an empty
  // line there would leave the item empty.
  const before = /[^\s>]/.test(prefix) ? '' : `\n${empty}\n${carry}`;
  return `${before}${element}\n${empty}\n${carry}`;
}

/**
 * Markdown as the HTML the body reads, its `$$` formulas as elements the two
 * formula nodes parse.
 * @param markdown - The Markdown.
 * @returns The HTML.
 */
export function formulaMarkdownToHTML(markdown: string): string {
  const found: Found[] = [];
  collect(reader.parse(markdown) as MdNode, false, found);
  if (found.length === 0) return markdownToHTML(markdown);
  let text = markdown;
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const { start, end, block } = found[i]!;
    const swap = block ? blockPlaceholder(markdown, start, i) : `<span ${INLINE_REF}="${String(i)}"></span>`;
    text = text.slice(0, start) + swap + text.slice(end);
  }
  const host = document.createElement('template');
  host.innerHTML = markdownToHTML(text);
  for (const [ref, own] of [[INLINE_REF, MATH_SOURCE_ATTR], [BLOCK_REF, MATH_BLOCK_SOURCE_ATTR]] as const) {
    host.content.querySelectorAll(`[${ref}]`).forEach((element) => {
      const formula = found[Number(element.getAttribute(ref))];
      element.removeAttribute(ref);
      element.setAttribute(own, formula?.source ?? '');
    });
  }
  return host.innerHTML;
}

/**
 * HTML with every formula written as an element carrying its source, its
 * words the `$$` text: how a table written as HTML keeps its formulas
 * (design 6.6). A Markdown reader takes the whole table as one HTML block and
 * never reads `$$` in it, so the body reads the source off the attribute, the
 * way it reads a formula copied from the chat.
 * @param html - HTML as the exporter writes it, one `<math>` per formula.
 * @returns The HTML.
 */
export function formulasAsSourceElements(html: string): string {
  const host = document.createElement('template');
  host.innerHTML = html;
  host.content.querySelectorAll('math').forEach((math) => {
    const block = math.getAttribute('display') === 'block';
    const source = math.querySelector(TEX_ANNOTATION)?.textContent ?? '';
    (math.closest('.katex-display') ?? math.closest('.katex') ?? math).replaceWith(formulaSourceHolder(source, block));
  });
  return host.innerHTML;
}
