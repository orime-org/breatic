// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The formula nodes of the document body (inner#1423): a block of its own
 * (`mathBlock`) and one inside a line (`math`). Both are leaves holding their
 * LaTeX in a `source` prop and read as their `$$` text.
 *
 * The browser's editor adds how a formula is drawn, edited, parsed from HTML
 * and copied ({@link DocMathView}); collab builds these specs with no view at
 * all (breatic#1488 §11.1), and the schema is the same either way.
 */

import { createBlockSpec, createExtension, createInlineContentSpec } from '@blocknote/core';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

/** The block formula's type name. */
export const MATH_BLOCK = 'mathBlock';

/** The inline formula's type name. */
export const MATH_INLINE = 'math';

/**
 * Whether a node is a formula, block or inline.
 * @param node - The node.
 * @returns True for `mathBlock` and `math`.
 */
export function isFormula(node: PMNode): boolean {
  return node.type.name === MATH_BLOCK || node.type.name === MATH_INLINE;
}

/**
 * A formula's LaTeX, read off its node.
 * @param node - A `mathBlock` or `math` node.
 * @returns The source.
 */
export function formulaSource(node: PMNode): string {
  return String(node.attrs['source'] ?? '');
}

/**
 * How a formula reads as text: `$$source$$` inside a line, the source between
 * two `$$` lines for a block, as the Agent reads it.
 * @param node - A `mathBlock` or `math` node.
 * @returns The text.
 */
export function formulaLeafText(node: PMNode): string {
  const source = formulaSource(node);
  return node.type.name === MATH_BLOCK ? `$$\n${source}\n$$` : `$$${source}$$`;
}

/**
 * A leaf reader for `textBetween` that reads a formula as its text and every
 * other leaf as `other` does: a reader passed to `textBetween` wins over the
 * node's own `leafText` (`prosemirror-model` 1.25.12 `index.js:122-123`).
 * @param other - What any other leaf reads as.
 * @returns The reader.
 */
export function leafWords(other: (leaf: PMNode) => string): (leaf: PMNode) => string {
  return (leaf) => (isFormula(leaf) ? formulaLeafText(leaf) : other(leaf));
}

/**
 * Whether a node is a formula with a source, which counts as content for the
 * Agent and the bubble bar.
 * @param node - The node.
 * @returns True for a formula whose source is not only white space.
 */
export function holdsFormula(node: PMNode): boolean {
  return isFormula(node) && formulaSource(node).trim() !== '';
}

/** Gives both formula nodes their text, which `textContent` and `textBetween` read. */
const FormulaText = Extension.create({
  name: 'documentFormulaText',
  extendNodeSchema: (extension) =>
    extension.name === MATH_BLOCK || extension.name === MATH_INLINE ? { leafText: formulaLeafText } : {},
});

/** Registered with the block spec, so every editor built from the schema has it. */
const formulaTextExtension = createExtension({ key: 'document-formula-text', tiptapExtensions: [FormulaText] });

/** How the browser draws, parses and exports one kind of formula. */
export interface DocMathImplementation {
  readonly parse: (element: HTMLElement) => { source: string } | undefined;
  readonly render: (...args: never[]) => unknown;
  readonly toExternalHTML: (formula: { readonly props: { readonly source: string } }) => { dom: HTMLElement };
}

/**
 * What the browser's editor adds to the formulas, none of which changes the
 * schema.
 */
export interface DocMathView {
  readonly block?: DocMathImplementation;
  readonly inline?: DocMathImplementation;
  /** Editor extensions registered with the block spec, after the formula text. */
  readonly extensions?: readonly unknown[];
}

/**
 * A formula drawn as nothing, for an editor with no view; collab never draws.
 * @param tag - The element's tag.
 * @returns The render function.
 */
function blankRender(tag: 'div' | 'span'): () => { dom: HTMLElement } {
  return () => ({ dom: document.createElement(tag) });
}

/**
 * The block formula.
 * @param view - What the browser's editor adds; nothing by default.
 * @returns The block spec.
 */
export function mathBlockSpec(view: DocMathView = {}): unknown {
  return createBlockSpec(
    {
      type: MATH_BLOCK,
      propSchema: { quoted: { default: false }, source: { default: '' } },
      content: 'none',
    },
    (view.block ?? { render: blankRender('div') }) as never,
    [formulaTextExtension, ...(view.extensions ?? [])] as never,
  )();
}

/**
 * The inline formula.
 * @param view - What the browser's editor adds; nothing by default.
 * @returns The inline content spec.
 */
export function mathInlineSpec(view: DocMathView = {}): unknown {
  return createInlineContentSpec(
    { type: MATH_INLINE, propSchema: { source: { default: '' } }, content: 'none' },
    (view.inline ?? { render: blankRender('span') }) as never,
  );
}
