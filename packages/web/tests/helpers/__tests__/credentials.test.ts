// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { newCredentials, personalStudioSlug, readAccounts, rememberAccount } from '../credentials';

const made: string[] = [];

/**
 * A path in a throwaway directory, optionally holding some content.
 * @param content - What to write there, already stringified; nothing when omitted.
 * @returns The path.
 */
function accountsFile(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'accounts-'));
  made.push(dir);
  const path = join(dir, 'accounts.json');
  if (content !== undefined) writeFileSync(path, content, 'utf8');
  return path;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pair = { email: 'someone@breatic.test', password: 'long-enough-password' };

describe('the accounts each worker slot owns', () => {
  it('keeps each slot apart in one file', () => {
    const path = accountsFile();
    rememberAccount(0, 'A', pair, path);
    rememberAccount(1, 'A', { ...pair, email: 'other@breatic.test' }, path);
    rememberAccount(0, 'B', { ...pair, email: 'second@breatic.test' }, path);
    const held = readAccounts(path);
    expect(held['0']?.A?.email).toBe('someone@breatic.test');
    expect(held['0']?.B?.email).toBe('second@breatic.test');
    expect(held['1']?.A?.email).toBe('other@breatic.test');
  });

  it('refuses the one-pair file an earlier suite wrote, and says how to move it', () => {
    // Read as slot 0 with no record, it would make setup register a fresh pair
    // and leave the old accounts, their Projects and their credits behind.
    const path = accountsFile(JSON.stringify({ A: pair, B: pair }));
    expect(() => readAccounts(path)).toThrow(/"0"/);
  });

  it('answers nothing when no run has made an account yet', () => {
    expect(readAccounts(accountsFile())).toEqual({});
  });

  it('names the slot in a new address', () => {
    expect(newCredentials('A', 3).email).toMatch(/^smoke-a3-[0-9a-f]+@breatic\.test$/);
  });
});

describe('personalStudioSlug', () => {
  it('names the account and slot, and differs between two calls in one second', () => {
    const first = personalStudioSlug('A', 3);
    expect(first).toMatch(/^smoke-a3-[0-9a-f]+$/);
    expect(personalStudioSlug('A', 3)).not.toBe(first);
  });
});
