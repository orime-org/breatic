// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

// 生成面板在「这里本该有反馈」时说的每一句话。它们的共同点是：缺哪个语种，
// 那个语种的用户就只剩一片空白或一次静默 —— 而这正是这几句存在的理由。
// 起于 #1950 片6 的两句（`refuseInsertNoPrompt` 和当时叫 `videoPromptNotUsed`
// 的那句），#1966 新增两句（`catalogOffline`、✕ 的 `refuseRemoveNoPrompt`）并把
// 那句改名成 `promptNotUsed`；`catalogUnavailable` 更早就有。共五条。
//
// 仓里的 i18n 守卫盯不住这件事：`i18n-no-missing-keys` 只拿英文那份当
// 目录（`SOURCE_CATALOG = "locales/en.json"`），另外四份有没有它不看。
// 五份之间的平价保障是另一件事，还没做（#1873），所以这里自己钉一条。
const NOTICE_KEYS = [
  // 提示词那一格在模型不吃提示词时显示的说明，两个面板共用这一句。
  'canvas.generatePanel.promptNotUsed',
  // 点参考轨道的文本行时的两句拒绝语：插入说的是「放不进去」，✕ 说的是
  // 这一档的状态 —— 两个按钮问的是同一件事的两面，话不能是同一句。
  'canvas.generatePanel.refuseInsertNoPrompt',
  'canvas.generatePanel.refuseRemoveNoPrompt',
  // 面板不展开时弹的两句：取不到目录、以及离线（#1966）。
  'canvas.generatePanel.catalogUnavailable',
  'canvas.generatePanel.catalogOffline',
] as const;

describe.each(NOTICE_KEYS)('%s 五个语种都有', (key) => {
  it.each(LOCALE_CATALOGS)('%s 有这句话且不是空的', (_tag, catalog) => {
    const message = readPath(catalog, key);
    expect(typeof message).toBe('string');
    expect((message as string).trim()).not.toBe('');
  });

  it('四个非英文语种都真的翻过，不是把英文抄过去', () => {
    // 抄英文过去也能让上面那条通过，而用户读到的是一句外语。
    const english = readPath(LOCALE_CATALOGS[0][1], key);
    for (const [tag, catalog] of LOCALE_CATALOGS.slice(1)) {
      expect(readPath(catalog, key), tag).not.toBe(english);
    }
  });
});
