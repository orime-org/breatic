// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { getAvailableLocales } from '@breatic/shared';

import { LOCALE_CATALOGS } from '@web/test-utils/locale-catalogs';

describe('the test environment registers the whole list', () => {
  // `vitest.setup.ts` loops LOCALE_CATALOGS, so this is the assertion that
  // notices the loop being narrowed again. It was a hand-written list of four
  // that silently dropped `ko`, and nothing in 3102 tests went red for it:
  // an unregistered locale falls back to English, which reads like a pass.
  it('every catalog in the list is registered with the i18n engine', () => {
    const listed = LOCALE_CATALOGS.map(([tag]) => tag).slice().sort();
    const registered = getAvailableLocales().slice().sort();
    expect(registered).toEqual(listed);
  });
});
