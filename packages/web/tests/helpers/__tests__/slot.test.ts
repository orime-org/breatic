// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from 'vitest';

import { stateFile } from '../slot';

describe('stateFile', () => {
  it('gives each worker slot its own sign-in file per account', () => {
    expect(stateFile('A', 0)).toBe('playwright/.auth/0-a.json');
    expect(stateFile('B', 3)).toBe('playwright/.auth/3-b.json');
    expect(stateFile('A', 1)).not.toBe(stateFile('A', 2));
  });
});
