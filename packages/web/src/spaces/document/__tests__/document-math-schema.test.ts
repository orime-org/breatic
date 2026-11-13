// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design §5.1: the two formula nodes the body builds.
 *
 * Both are leaves holding their LaTeX in a `source` prop: no text of the
 * formula sits in the body, so no caret, selection or deletion of the body
 * reaches it. Neither declares `meta.hasPreview`, so BlockNote's own
 * source-in-a-box extensions stay off them. Both read as `$$source$$`
 * through ProseMirror's `leafText`, the way every text reader of the body
 * that passes no leaf reader of its own sees a formula.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { buildDocumentSchema } from '@web/spaces/document/document-schema-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

/** The parts of a spec these cases read. */
interface SpecView {
  readonly config: { readonly content: string; readonly propSchema: Readonly<Record<string, unknown>> };
  readonly implementation: { readonly meta?: { readonly hasPreview?: boolean } };
}

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * A mounted, empty document.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return editor;
}

/**
 * One block spec, read through the parts these cases look at.
 * @param type - The block type.
 * @returns The spec, or undefined when the schema has none.
 */
function blockSpec(type: string): SpecView | undefined {
  return (buildDocumentSchema().blockSpecs as unknown as Record<string, SpecView | undefined>)[type];
}

/**
 * One inline content spec, read through the parts these cases look at.
 * @param type - The inline content type.
 * @returns The spec, or undefined when the schema has none.
 */
function inlineSpec(type: string): SpecView | undefined {
  return (buildDocumentSchema().inlineContentSpecs as unknown as Record<string, SpecView | undefined>)[type];
}

describe('the formula block', () => {
  it('is a leaf block with a source prop and the quote prop every block carries', () => {
    expect(blockSpec('mathBlock')?.config.content).toBe('none');
    expect(Object.keys(blockSpec('mathBlock')?.config.propSchema ?? {})).toEqual(['quoted', 'source']);
  });

  it('turns on no source-in-a-box extension', () => {
    expect(blockSpec('mathBlock')?.implementation.meta?.hasPreview).not.toBe(true);
  });

  it('is a ProseMirror leaf that reads as its source between $$ lines', () => {
    const type = open().pmSchema.nodes.mathBlock!;
    const node = type.create({ source: '\\frac{a}{b}' });
    expect(node.isLeaf).toBe(true);
    expect(node.textContent).toBe('$$\n\\frac{a}{b}\n$$');
  });
});

describe('the inline formula', () => {
  it('is leaf inline content with a source prop', () => {
    expect(inlineSpec('math')?.config.content).toBe('none');
    expect(Object.keys(inlineSpec('math')?.config.propSchema ?? {})).toEqual(['source']);
  });

  it('turns on no source-in-a-box extension', () => {
    expect(inlineSpec('math')?.implementation.meta?.hasPreview).not.toBe(true);
  });

  it('is a ProseMirror inline leaf that reads as $$source$$', () => {
    const type = open().pmSchema.nodes.math!;
    const node = type.create({ source: 'a^2' });
    expect(node.isLeaf && node.isInline).toBe(true);
    expect(node.textContent).toBe('$$a^2$$');
  });
});
