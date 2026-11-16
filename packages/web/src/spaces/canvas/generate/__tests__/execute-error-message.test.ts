// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * 生成失败时用户读到哪一句（#89 补 507 这一支）。
 *
 * 存储满了必须说存储满了。落进 `default` 的话用户读到的是「生成失败」——
 * 一句放之四海而皆准、因而什么都没告诉他的话：他不知道该重试、该等一等、
 * 还是该去升级会员，而这三件事只有第三件有用。
 *
 * 顺带钉住 409 仍然归节点占用。它是本次选 507 而不是 409 的原因：409 早就
 * 有主了，两个含义共用一个状态码，前端这个 switch 分不出来。
 */

import { describe, it, expect } from 'vitest';
import { ApiException } from '@web/data/api/types';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';

/** 把键原样返回，断言的就是「挑中了哪个键」。 */
const echo = (key: string): string => key;

describe('executeErrorMessage', () => {
  it('says storage is full on 507', async () => {
    expect(await executeErrorMessage(new ApiException({ status: 507, message: 'full' }), echo)).toBe(
      'canvas.generatePanel.errorStorageFull',
    );
  });

  it('still falls back for a status it has no sentence for', async () => {
    expect(await executeErrorMessage(new ApiException({ status: 500, message: 'broke' }), echo)).toBe(
      'canvas.generatePanel.errorFailed',
    );
    expect(await executeErrorMessage(undefined, echo)).toBe(
      'canvas.generatePanel.errorFailed',
    );
  });
});

// inner#1968 D-22: the run is refused because the month's operations are used
// up and the studio cannot pay for one more. The function reads the whole
// refusal, so the reason picks the sentence before the status does.
describe('executeErrorMessage for operations used up', () => {
  it('says something other than the plain credits sentence', async () => {
    const usedUp = new ApiException({ status: 402, message: 'used up', reason: 'operations_exhausted', fromServer: true });
    const credits = new ApiException({ status: 402, message: 'credits', fromServer: true });
    const said = await executeErrorMessage(usedUp, echo);
    expect(said).not.toBe(await executeErrorMessage(credits, echo));
    expect(said).not.toBe('canvas.generatePanel.errorCredits');
  });
});
