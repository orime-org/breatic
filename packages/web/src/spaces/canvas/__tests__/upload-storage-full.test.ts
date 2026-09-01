// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 上传被存储配额拒掉之后，前端认不认得出这是哪一种失败（#89）。
 *
 * 认错了没有任何东西会崩：用户读到的是「上传失败，请重试」，节点上还会亮起
 * 一个 Retry 按钮，点它就是再问一次没人腾出来的空间。所以这条分支只能靠断言
 * 钉住 —— 实现对抗第一轮实测：把 507 的判定改成恒为假，canvas 下 1744 条
 * 测试无一变红。
 *
 * 两个入口共用同一个判定和同一个出口，这里两个都钉：
 *
 *   1. 拖拽进画布（`runMediaUpload`，请票时直接抛 507）；
 *   2. 双击 / Upload 菜单填充已有节点（`fillNodeFromFile`）。
 */

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import {
  runMediaUpload,
  fillNodeFromFile,
  type MediaUploadDeps,
  type FillNodeDeps,
  type UploadFailureReason,
} from '@web/spaces/canvas/canvas-upload';

const CONFIG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 1,
  clientRetryBaseDelayMs: 1,
  clientRequestTimeoutMs: 30000,
  clientPutMinBytesPerSec: 65536,
};

/** 服务端存储满时的答复，形状跟 apiGet 交给前端的一样。 */
function storageFull(): ApiException {
  return new ApiException({
    status: 507,
    message: 'Studio 存储已满，当前无法上传。',
    fromServer: true,
  });
}

/** 一个图片文件，够小、不碰单文件上限。 */
function pngFile(name = 'a.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

/**
 * 一套只到请票就被拒的上传依赖。
 * @param onFailure - 失败出口。
 * @returns 可直接交给 runMediaUpload 的依赖。
 */
function refusingDeps(
  onFailure: (reason: UploadFailureReason) => void,
): MediaUploadDeps {
  return {
    getUploadConfig: async () => CONFIG,
    hashFile: async () => 'a'.repeat(64),
    requestTicket: async () => {
      throw storageFull();
    },
    sendToIngest: async () => ({}),
    onSuccess: () => {
      throw new Error('不该成功');
    },
    onFailure,
  } as unknown as MediaUploadDeps;
}

describe('507 被认成 storage 而不是普通上传失败', () => {
  it('拖拽进画布这条', async () => {
    const onFailure = vi.fn();
    await runMediaUpload(
      pngFile(),
      { projectId: 'p1', leaseGen: 0 },
      refusingDeps(onFailure),
    );
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('storage');
  });

  it('leaves an ordinary ticket failure outside the 507 branch', async () => {
    const onFailure = vi.fn();
    await runMediaUpload(pngFile(), { projectId: 'p1', leaseGen: 0 }, {
      ...refusingDeps(onFailure),
      requestTicket: async () => {
        throw new ApiException({
          status: 503,
          message: 'down',
          fromServer: true,
        });
      },
    } as unknown as MediaUploadDeps);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('upload');
  });
});

describe('填充已有节点这条把失败原样交给唯一的出口', () => {
  /**
   * 一套填充依赖，请票一律答存储满。
   * @param extra - 要覆盖或补上的部分。
   * @returns 可直接交给 fillNodeFromFile 的依赖。
   */
  function fillDeps(extra: Partial<FillNodeDeps>): FillNodeDeps {
    return {
      getUploadConfig: async () => CONFIG,
      hashFile: async () => 'a'.repeat(64),
      requestTicket: async () => {
        throw storageFull();
      },
      sendToIngest: async () => ({}),
      extractText: async () => '',
      isHandling: () => false,
      onTypeMismatch: () => {},
      // 形状照 UploadLease 的定义写：替身返回的东西跟被替代那个函数的返回
      // 类型不是同一个的话，测的就只是替身自己。
      setHandling: () => ({ gen: 1, clientId: 7, userId: 'u1' }),
      setContent: () => true,
      setError: () => true,
      onUploadFailure: () => {},
      ...extra,
    } as unknown as FillNodeDeps;
  }

  it('把 storage 交给出口，自己不写节点', async () => {
    const onUploadFailure = vi.fn((_reason: UploadFailureReason) => {});
    const setError = vi.fn(() => true);
    await fillNodeFromFile('n1', pngFile(), 'image', 'p1', fillDeps({
      onUploadFailure,
      setError,
    }));
    expect(onUploadFailure).toHaveBeenCalledOnce();
    expect(onUploadFailure.mock.calls[0]?.[0]).toBe('storage');
    // 用户读到的那句话由出口那一处写。这个模块自己不留一份，否则同一句话
    // 有两份、改一份不影响用户看到的那份。
    expect(setError).not.toHaveBeenCalled();
  });
});
