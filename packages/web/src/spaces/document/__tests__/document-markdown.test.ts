// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Markdown read with the document's own schema and no document open
 * (inner#1509): what a proposal's body becomes, block by block, and the plain
 * text each block reads as -- the same text the landing compares against.
 */

import { describe, expect, it } from 'vitest';

import { markdownBlocks } from '@web/spaces/document/document-markdown';

describe('markdownBlocks', () => {
  it('reads each block with its type and its plain text', async () => {
    const got = await markdownBlocks('A **bold** [link](https://example.com)\n\n## Scene 3\n\n| Shot | Size |\n|---|---|\n| 1 | Wide |');

    expect(got.map((b) => [(b.block as { type?: unknown }).type, b.text])).toEqual([
      ['paragraph', 'A bold link'],
      ['heading', 'Scene 3'],
      ['table', 'Shot\nSize\n1\nWide'],
    ]);
  });

  it('keeps the items under a list item with it', async () => {
    const got = await markdownBlocks('* Props\n  * A map');

    expect(got.map((b) => b.text)).toEqual(['Props\nA map']);
  });

  it('reads nothing from an empty body', async () => {
    expect(await markdownBlocks('')).toEqual([]);
  });
});
