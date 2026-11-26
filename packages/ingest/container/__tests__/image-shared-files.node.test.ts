// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const INGEST = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHARED_SRC = resolve(INGEST, '../shared/src');

/**
 * The shared sources the container service reaches from its entry, as the compiler resolves its imports.
 * @returns Their paths under packages/shared/src.
 * @throws {Error} When the container tsconfig cannot be read.
 */
function reachedSharedFiles(): string[] {
  const configPath = resolve(INGEST, 'container/tsconfig.json');
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  const program = ts.createProgram([resolve(INGEST, 'container/server.ts')], options);
  return program.getSourceFiles().map((file) => resolve(file.fileName)).filter((path) => path.startsWith(`${SHARED_SRC}/`))
    .map((path) => relative(SHARED_SRC, path)).sort();
}

describe('the media container image', () => {
  it('copies every shared source the bundled service imports into its build stage', () => {
    const dockerfile = readFileSync(resolve(INGEST, 'Dockerfile'), 'utf8');
    const copied = new Set([...dockerfile.matchAll(/^COPY packages\/shared\/src\/(\S+) \/shared\/src\/\1$/gm)].map((match) => match[1]));
    const reached = reachedSharedFiles();
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter((path) => !copied.has(path))).toEqual([]);
  });
});
