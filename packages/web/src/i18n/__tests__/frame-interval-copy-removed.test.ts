// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame extraction keeps only First, Last and Current (inner#1306 test plan §97; frames-split design §10.6 删除行, tools
 * design acceptance item 5), so the copy that served only the interval mode leaves every shipped locale while the three
 * kept modes keep theirs.
 */

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

describe('frame extraction copy after the interval mode is removed', () => {
  it.each(LOCALE_CATALOGS)('%s keeps First, Last and Current and has no interval label', (_tag, catalog) => {
    for (const mode of ['first', 'last', 'current']) expect(typeof readPath(catalog, `canvas.miniTool.videoUI.${mode}`)).toBe('string');
    expect(readPath(catalog, 'canvas.miniTool.videoUI.interval')).toBeUndefined();
  });
});
