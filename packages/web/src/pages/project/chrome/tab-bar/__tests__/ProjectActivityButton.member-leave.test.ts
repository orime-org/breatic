// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The activity panel and the Agent's activity tool tell a member leaving of
 * their own accord the same way only while both ask one function, shared's
 * `isMemberLeave` (inner#1469); a second copy in the panel drifts.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const source = readFileSync(path.join(import.meta.dirname, '..', 'ProjectActivityButton.tsx'), 'utf8');

describe('the activity panel', () => {
  it('asks the shared isMemberLeave whether a member left', () => {
    const shared = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@breatic\/shared'/g)].map((m) => m[1] ?? '');

    expect(shared.some((names) => /\bisMemberLeave\b/.test(names))).toBe(true);
  });

  it('keeps no copy of its own', () => {
    expect(source).not.toMatch(/function\s+isLeave\b/);
  });
});
