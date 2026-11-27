// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The desktop client keeps a page in its window only when `isAppPath` says it
 * is the app's (inner#2041). Every top-level route the app serves must be on that
 * list, or the client would hand the page to the system browser.
 */

import { describe, it, expect } from 'vitest';
import { isAppPath } from '@breatic/shared';
import { baseRoutes } from '@web/app/routes';

describe('app route prefixes', () => {
  it('cover every top-level route the app serves', () => {
    const paths = baseRoutes
      .map((route) => route.path)
      .filter((path): path is string => typeof path === 'string' && path !== '/' && path !== '*');
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      const concrete = path.replace(/\/:[^/]+.*$/, '').replace(/\/\*$/, '');
      expect(isAppPath(concrete), path).toBe(true);
    }
  });
});
