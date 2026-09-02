// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The BlockNote schema this Space runs on.
 *
 * `BlockNoteSchema.create` REPLACES each of the three spec groups rather than
 * merging (`BlockNoteSchema.ts:52-57` is three `??`), so passing one group
 * without spreading its defaults silently drops the rest. Losing
 * `inlineContentSpecs` takes `link` with it, and the whole address ruling
 * from #903 hangs off that node — hence the group that asserts it survives.
 *
 * The nine enabled types and the seven turned off are the block-type menu's
 * contract: anything still in the schema can be built by a chord or an input
 * rule, and the menu would then meet a block it cannot name.
 */

import { describe, it, expect } from 'vitest';

import { buildDocumentSchema } from '@web/spaces/document/document-schema-blocknote';

/** The nine types the block-type menu offers. */
const ENABLED = [
  'paragraph',
  'heading',
  'codeBlock',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
] as const;

/** Turned off this version, so they fall into the fallback path instead. */
const DISABLED = [
  'quote',
  'toggleListItem',
  'divider',
  'table',
  'image',
  'video',
  'audio',
  'file',
] as const;

describe('the document schema', () => {
  it('registers every enabled block type', () => {
    const schema = buildDocumentSchema();
    for (const type of ENABLED) {
      expect(Object.keys(schema.blockSchema)).toContain(type);
    }
  });

  it('leaves the turned-off types out', () => {
    const schema = buildDocumentSchema();
    for (const type of DISABLED) {
      expect(Object.keys(schema.blockSchema)).not.toContain(type);
    }
  });

  it('keeps `link`, which the address ruling hangs off', () => {
    const schema = buildDocumentSchema();
    expect(Object.keys(schema.inlineContentSchema)).toContain('link');
  });

  it('keeps the default styles', () => {
    const schema = buildDocumentSchema();
    for (const style of ['bold', 'italic', 'underline', 'strike', 'code']) {
      expect(Object.keys(schema.styleSchema)).toContain(style);
    }
  });

  it('gives every block a `quoted` prop, since a quote coexists with all nine', () => {
    const schema = buildDocumentSchema();
    for (const type of ENABLED) {
      expect(Object.keys(schema.blockSchema[type].propSchema)).toContain('quoted');
    }
  });

  it('gives a heading the two props that let it carry a number', () => {
    const schema = buildDocumentSchema();
    const props = Object.keys(schema.blockSchema.heading.propSchema);
    expect(props).toContain('numbered');
    expect(props).toContain('number');
  });

  it('gives a numbered list item the settable-number prop', () => {
    const schema = buildDocumentSchema();
    expect(
      Object.keys(schema.blockSchema.numberedListItem.propSchema),
    ).toContain('number');
  });
});
