// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

// 口播档那一格的说明（#1950 片6）。这一档没有提示词框，只有这句话解释
// 为什么，所以它缺一个语种，那个语种的用户就只剩一片空白。
//
// 仓里的 i18n 守卫盯不住这件事：`i18n-no-missing-keys` 只拿英文那份当
// 目录（`SOURCE_CATALOG = "locales/en.json"`），另外四份有没有它不看。
// 五份之间的平价保障是另一件事，还没做（#1873），所以这里自己钉一条。
const NOTICE_KEY = 'canvas.generatePanel.videoPromptNotUsed';

describe('口播档那一格的说明，五个语种都有', () => {
  it.each(LOCALE_CATALOGS)('%s 有这句话且不是空的', (_tag, catalog) => {
    const message = readPath(catalog, NOTICE_KEY);
    expect(typeof message).toBe('string');
    expect((message as string).trim()).not.toBe('');
  });

  it('四个非英文语种都真的翻过，不是把英文抄过去', () => {
    // 抄英文过去也能让上面那条通过，而用户读到的是一句外语。
    const english = readPath(LOCALE_CATALOGS[0][1], NOTICE_KEY);
    for (const [tag, catalog] of LOCALE_CATALOGS.slice(1)) {
      expect(readPath(catalog, NOTICE_KEY), tag).not.toBe(english);
    }
  });
});
