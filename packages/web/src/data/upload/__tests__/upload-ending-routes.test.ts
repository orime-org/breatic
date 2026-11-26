// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Every upload the page waits for ends through the one table in `upload-status.ts` (#1580, test spec J-21, J-23):
 * the mini-tool drawing, the 3D viewfinder, Agent attachments and Timeline clips through `runMediaUpload`, the four
 * transfer bodies through `bodyOrTransfer`. No caller brings a wait of its own, so the table, which asks the server
 * nothing (J-22), is woken by `upload:ended` for all of them.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(import.meta.dirname, '..', '..', '..');

/**
 * Every non-test source file under `dir`.
 * @param dir - Where to start.
 * @returns Their paths relative to `src`.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) ? [path.relative(SRC, full)] : [];
  });
}

const FILES = sources(SRC).map((file) => ({ file, text: readFileSync(path.join(SRC, file), 'utf8') }));

describe('where an upload\'s ending is waited for', () => {
  it('J-21 no caller hands the upload pipeline a wait of its own', () => {
    expect(FILES.filter((f) => /\bwaitForEnding\s*:/.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it('J-21 and J-23 only the upload pipeline and the transfer body wait on the table', () => {
    const importsWait = /import\s*\{[^}]*\bwaitForUploadEnding\b[^}]*\}\s*from\s*'@web\/data\/upload\/upload-status'/;
    const waiters = FILES.filter((f) => importsWait.test(f.text)).map((f) => f.file).sort();
    expect(waiters).toEqual(['data/upload/media-upload.ts', 'data/upload/transfer-body.ts']);
  });
});
