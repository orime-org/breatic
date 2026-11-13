// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 design §5.1: the two formula nodes the body builds.
 *
 * Both hold their LaTeX source as plain text and declare `meta.hasPreview`,
 * which is what turns on BlockNote's own source-with-preview extensions, and
 * `meta.code`, which the paste and divider paths read to treat the source as
 * code. The block resets to itself on Backspace, so the reset step of the
 * Backspace chain never turns a formula into a paragraph.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { buildDocumentSchema } from '@web/spaces/document/document-schema-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

/** The parts of a spec these cases read. */
interface SpecView {
  readonly config: { readonly content: string };
  readonly implementation: {
    readonly meta?: { readonly hasPreview?: boolean; readonly code?: boolean };
    readonly keyboard?: (block: unknown) => { readonly resetsTo?: { readonly type: string } };
  };
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
  it('is a block of plain source text', () => {
    expect(blockSpec('mathBlock')?.config.content).toBe('plain');
  });

  it('declares a preview and code source', () => {
    expect(blockSpec('mathBlock')?.implementation.meta).toMatchObject({ hasPreview: true, code: true });
  });

  it('resets to itself, never to a paragraph', () => {
    const keyboard = blockSpec('mathBlock')?.implementation.keyboard;
    expect(keyboard?.({ type: 'mathBlock', props: { quoted: false }, content: '', children: [] }).resetsTo?.type).toBe(
      'mathBlock',
    );
  });

  it('carries the quote prop every block carries', () => {
    expect(Object.keys(buildDocumentSchema().blockSchema)).toContain('mathBlock');
    const schema = buildDocumentSchema().blockSchema as unknown as Record<string, { propSchema: object }>;
    expect(Object.keys(schema.mathBlock?.propSchema ?? {})).toEqual(['quoted']);
  });

  it('is a ProseMirror code node holding text', () => {
    const node = open().pmSchema.nodes.mathBlock;
    expect(node?.spec.code).toBe(true);
    expect(node?.spec.content).toBe('text*');
  });
});

describe('the inline formula', () => {
  it('is inline content of plain source text', () => {
    expect(inlineSpec('math')?.config.content).toBe('plain');
  });

  it('declares a preview and code source', () => {
    expect(inlineSpec('math')?.implementation.meta).toMatchObject({ hasPreview: true, code: true });
  });

  it('is a ProseMirror code node holding text', () => {
    const node = open().pmSchema.nodes.math;
    expect(node?.spec.code).toBe(true);
    expect(node?.spec.content).toBe('text*');
  });
});
