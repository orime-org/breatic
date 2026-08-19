// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

// 存储满了之后，用户会读到的每一句话（#89）。四句，四个不同的出口：
//
//   1. 服务端那句，随 507 的响应体回来，经 `t()` 按请求方语言本地化；
//   2. 生成面板按状态码挑的那句；
//   3. 上传被拒时给操作者本人的本地提示（节点上那句是固定英文，写进 Yjs
//      给全体协作者看，不在这里 —— 它不该被任何语种冻住）；
//   4. 铃铛里给 studio admin 的那条。
//
// 缺哪一句，那个语种的用户就只剩一个裸 key 或一句「生成失败」，而这四句
// 存在的全部理由就是把「该去升级会员」这件事说出来。
//
// 仓里的 i18n 守卫盯不住这件事：`i18n-no-missing-keys` 只拿英文那份当目录
// （`SOURCE_CATALOG = "locales/en.json"`），另外四份有没有它不看。五份之间
// 的平价保障还没做（#1873），所以这里自己钉一条。
const STORAGE_FULL_KEYS = [
  'server.storage.quota_exceeded_upload',
  'server.storage.quota_exceeded_generate',
  'canvas.generatePanel.errorStorageFull',
  'canvas.upload.storageFull',
  'notifications.headline.storageQuotaExceeded',
] as const;

describe.each(STORAGE_FULL_KEYS)('%s 五个语种都有', (key) => {
  it.each(LOCALE_CATALOGS)('%s 有这句话且不是空的', (_tag, catalog) => {
    const message = readPath(catalog, key);
    expect(typeof message).toBe('string');
    expect((message as string).trim()).not.toBe('');
  });
});
