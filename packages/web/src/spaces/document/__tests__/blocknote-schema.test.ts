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
 * The enabled types and the ones turned off are the block-type menu's
 * contract: anything still in the schema can be built by a chord or an input
 * rule, and the menu would then meet a block it cannot name. The divider is
 * the one enabled type the block-type menu does not offer: it is placed by
 * `---` and by the insert-below menu (#124).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { buildDocumentSchema } from '@web/spaces/document/document-schema-blocknote';

/** The types this Space builds. */
const ENABLED = [
  'paragraph',
  'heading',
  'codeBlock',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'divider',
  'table',
  'image',
  'video',
  'audio',
] as const;

/** Turned off this version, so they fall into the fallback path instead. */
const DISABLED = [
  'quote',
  'toggleListItem',
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

  it('gives image and video a width and an alignment, and audio neither (inner#1127 A8, A9)', () => {
    const schema = buildDocumentSchema();
    for (const type of ['image', 'video'] as const) {
      const props = Object.keys(schema.blockSchema[type].propSchema);
      expect(props).toEqual(
        expect.arrayContaining(['url', 'name', 'caption', 'previewWidth', 'textAlignment']),
      );
    }
    const audio = Object.keys(schema.blockSchema.audio.propSchema);
    expect(audio).toEqual(expect.arrayContaining(['url', 'name', 'caption']));
    expect(audio).not.toContain('previewWidth');
    expect(audio).not.toContain('textAlignment');
  });

  it('lets only the divider and the three media blocks be blocks with no content that carry `quoted`', () => {
    // `handleQuotedEnter`'s empty branch reads the caret's offset off the
    // block it is in, and reads it as 0 without asking. A block with no
    // content never gets there: the only selection it can hold is a node
    // selection, and Enter over one goes to `handleWholeBlockEnter` first
    // (`document-enter.ts`). That was checked for the divider (#124) and for
    // the media blocks (inner#1127). Another such block has to be checked the
    // same way before it joins this list.
    const schema = buildDocumentSchema();
    const noContentCarriers = Object.entries(schema.blockSchema)
      .filter(([, config]) => 'quoted' in config.propSchema)
      .filter(([, config]) => config.content === 'none')
      .map(([type]) => type);
    expect(noContentCarriers.sort()).toEqual(['audio', 'divider', 'image', 'video']);
  });

  it('gives a numbered list item the settable-number prop', () => {
    const schema = buildDocumentSchema();
    expect(
      Object.keys(schema.blockSchema.numberedListItem.propSchema),
    ).toContain('number');
  });
});

describe('the schema migrations BlockNote runs over a bound document', () => {
  it('holds the one rule this version was read against', () => {
    // `SchemaMigration` rewrites the SHARED document on bind, and the rules it
    // runs are internal — the extension exposes none of them, and the package
    // exports no path that reaches the table. It ships its `src`, so the table
    // is read there, as the line that builds it.
    //
    // What this protects: today the single rule moves colour attributes,
    // which our documents cannot carry, so the migration is a no-op and the
    // bytes survive binding. A second rule arriving in an upgrade is a
    // rewrite of everyone's document that nothing else here would notice —
    // whether it arrives as a new file or as a name added to this line.
    const require_ = createRequire(resolve('package.json'));
    const packageRoot = dirname(dirname(require_.resolve('@blocknote/core')));
    const table = readFileSync(
      join(
        packageRoot,
        'src/yjs/extensions/schemaMigration/migrationRules/index.ts',
      ),
      'utf8',
    );

    expect(table).toContain('export default [moveColorAttributes]');
  });
});
