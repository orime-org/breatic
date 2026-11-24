// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';

import { followTarget } from '@web/features/follow/follow-target';

const NAMES: ReadonlyMap<string, string> = new Map([['me', 'Me'], ['wang', 'Wang Fang']]);

describe('followTarget', () => {
  it('names whom a member follows here: this user, a member on the roster, or nobody', () => {
    expect(followTarget('me', 'me', NAMES)).toBe('you');
    expect(followTarget('wang', 'me', NAMES)).toEqual({ name: 'Wang Fang' });
    expect(followTarget(null, 'me', NAMES)).toBeNull();
    expect(followTarget(undefined, 'me', NAMES)).toBeNull();
  });

  it('counts someone off the roster as nobody', () => {
    expect(followTarget('gone', 'me', NAMES)).toBeNull();
  });

  it('reads this user as on the roster before the user id is known only by name', () => {
    expect(followTarget('me', null, NAMES)).toEqual({ name: 'Me' });
  });
});
