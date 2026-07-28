// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Contract: the alias that `no-relative-import-paths` autofixes to must be one
 * TypeScript can actually resolve.
 *
 * The plugin builds the fixed specifier as `[prefix, ...segments].join('/')`
 * (eslint-plugin-no-relative-import-paths@1.6.1 index.js `getAbsolutePath`), so
 * `prefix` becomes the FIRST PATH SEGMENT, not a bare sigil. With `prefix: '@'`
 * a fix emits `@/pages/Foo`, which no `paths` entry maps — the rule would
 * silently rewrite working relative imports into unresolvable ones.
 *
 * This pins the two config files together so they cannot drift apart again.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Read the alias prefixes declared in the web package tsconfig `paths`.
 *
 * @returns Prefixes with the trailing `/*` stripped, e.g. `['@web', '@shared']`.
 * @throws {Error} If tsconfig.json cannot be read or has no `paths`.
 */
function readTsconfigAliasPrefixes(): string[] {
  const raw = readFileSync(resolve(WEB_ROOT, 'tsconfig.json'), 'utf-8');
  // tsconfig allows comments; strip line comments before parsing.
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  const parsed = JSON.parse(stripped) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths = parsed.compilerOptions?.paths;
  if (!paths) throw new Error('web tsconfig.json declares no compilerOptions.paths');
  return Object.keys(paths).map((key) => key.replace(/\/\*$/, ''));
}

/**
 * Read the `prefix` option configured for the no-relative-import-paths rule.
 *
 * Parsed as text rather than by importing the flat config, so the test stays
 * independent of the ESLint runtime and its plugin graph.
 *
 * @returns The configured prefix string.
 * @throws {Error} If the rule options block cannot be located.
 */
function readEslintAliasPrefix(): string {
  const raw = readFileSync(resolve(WEB_ROOT, 'eslint.config.mts'), 'utf-8');
  const match = raw.match(/prefix:\s*'([^']*)'/);
  if (!match) throw new Error('no-relative-import-paths prefix option not found');
  return match[1];
}

/**
 * Reproduce the plugin's fixer output for a source file under `rootDir`.
 *
 * Mirrors `getAbsolutePath`: the prefix is joined as the leading segment.
 *
 * @returns The specifier the autofixer would write.
 */
function autofixedSpecifier(prefix: string, segments: string[]): string {
  return [prefix, ...segments].filter(String).join('/');
}

describe('import alias contract (eslint autofix ↔ tsconfig paths)', () => {
  it('emits a specifier that a tsconfig paths entry maps', () => {
    const prefix = readEslintAliasPrefix();
    const tsconfigPrefixes = readTsconfigAliasPrefixes();
    const emitted = autofixedSpecifier(prefix, ['pages', 'studio', 'StudioRecentPage']);

    const matched = tsconfigPrefixes.some((p) => emitted.startsWith(`${p}/`));

    expect(
      matched,
      `autofix would emit "${emitted}", which none of ${JSON.stringify(tsconfigPrefixes)} maps`,
    ).toBe(true);
  });

  it('uses the alias that existing source imports already use', () => {
    expect(readEslintAliasPrefix()).toBe('@web');
  });
});
