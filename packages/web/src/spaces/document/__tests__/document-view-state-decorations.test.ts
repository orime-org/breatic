// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A1: a drag preview is a copy of the body and shows the content
 * alone. What the body paints for the moment is taken off the copy by what
 * each such decoration recorded when it was made (`document-view-state.ts`),
 * so every decoration in the body is either made there or is part of how the
 * content looks. A file that calls `Decoration` itself has to be one of the
 * second kind, named here with what it paints.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The document space's sources. */
const ROOT = resolve(import.meta.dirname, '..');

/** The files whose own decorations are part of how the content looks. */
const CONTENT_DECORATIONS = new Map<string, string>([
  ['document-decorations.ts', 'a quote run\'s rule and the space that clears it'],
  ['document-unsupported-blocknote.ts', 'the label an unsupported block shows in its place'],
  ['document-body-focus.ts', 'no attributes: a spec the body reads whether it holds the focus by'],
  ['document-view-state.ts', 'the view-state decorations themselves'],
]);

/**
 * Every source file under a directory, tests left out.
 * @param dir - The directory.
 * @returns The files' paths.
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the decorations in the document body', () => {
  it('are made as view state unless they are part of how the content looks', () => {
    const own = sources(ROOT)
      .filter((path) => /\bDecoration\.(node|inline|widget)\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))
      .filter((path) => !CONTENT_DECORATIONS.has(path));

    expect(own).toEqual([]);
  });
});
