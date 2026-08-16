// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

// #1950 片6 新增的两句用户可见文案。一句解释这一档为什么没有提示词框，
// 一句在用户点参考轨道的文本行时说明插不进去 —— 两句都是「这里本该有反馈」
// 的那个反馈本身，缺一个语种，那个语种的用户就只剩一片空白或一次静默。
//
// 仓里的 i18n 守卫盯不住这件事：`i18n-no-missing-keys` 只拿英文那份当
// 目录（`SOURCE_CATALOG = "locales/en.json"`），另外四份有没有它不看。
// 五份之间的平价保障是另一件事，还没做（#1873），所以这里自己钉一条。
const NOTICE_KEYS = [
  // 那一格的说明：视频面板一句（口播档专用），图片面板一句（通用）。
  'canvas.generatePanel.videoPromptNotUsed',
  'canvas.generatePanel.promptNotUsed',
  // 点参考轨道时的拒绝语。插入一句只说原因；移除两句要说出路，焦点裁剪
  // 没有「删掉那条连线」这条出路，所以它自己一句。
  'canvas.generatePanel.refuseInsertNoPrompt',
  'canvas.generatePanel.refuseRemoveNoPrompt',
  'canvas.generatePanel.refuseRemoveNoPromptCrop',
  // 离线时点生成弹的那句（#1966）。
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
