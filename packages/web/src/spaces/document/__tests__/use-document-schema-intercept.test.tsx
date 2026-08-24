// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 只读拦截的判定：只认 meta 版本比对这一个条件（#121 定稿 §7，
 * user 2026-08-17 拍定；「文档里有解析不了的内容」不再是条件——那类内容
 * 走 Unsupported 兜底渲染，见 unknown-content-does-not-intercept 测试）。
 *
 * 判定**从 meta 文档派生**，不存任何本地状态：切 Space tab 走一圈回来，
 * 组件重挂载、重新派生一次，算出的是同一个答案。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
} from '@breatic/shared';

import { useDocumentSchemaIntercept } from '@web/spaces/document/use-document-schema-intercept';

const docs: Y.Doc[] = [];

afterEach(() => {
  docs.splice(0).forEach((d) => d.destroy());
});

/**
 * 造一个 project 的 meta 文档。
 * @returns meta 文档。
 */
function meta(): Y.Doc {
  const metaDoc = new Y.Doc();
  docs.push(metaDoc);
  return metaDoc;
}

/**
 * 往 meta 里写一份 schema，模拟服务器发布过。
 *
 * 判定看的是 `version`，清单跟着它走、不参与比较（user 2026-08-14）。
 * @param metaDoc - meta 文档。
 * @param version - 服务器那一版；不给就跟本 build 同版。
 * @param publishedAt - 发布时间。
 */
function publish(
  metaDoc: Y.Doc,
  version: string = DOCUMENT_SCHEMA_VERSION,
  publishedAt = '2026-08-13T06:20:00.000Z',
): void {
  metaDoc.transact(() => {
    const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
    map.set('version', version);
    map.set('nodes', DOCUMENT_SCHEMA.nodes);
    map.set('marks', DOCUMENT_SCHEMA.marks);
    map.set('publishedAt', publishedAt);
  });
}

describe('版本一致或未知：不拦', () => {
  it('meta 里那份跟我一样 → 不拦', () => {
    const metaDoc = meta();
    publish(metaDoc);

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );

    expect(result.current.intercepted).toBe(false);
  });

  it('meta 里根本还没有那个键 → 不拦（没有信息不等于不一致）', () => {
    const metaDoc = meta();

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );

    expect(result.current.intercepted).toBe(false);
  });

  it('版本号一样时，清单内容不管长什么样都不拦', () => {
    // 判定只看版本号。清单跟着版本号一起发布，它自己不参与比较 ——
    // 而版本号就是这两张清单的摘要，改了清单它自己就变，没有要人记得改的
    // 数字。
    const metaDoc = meta();
    metaDoc.transact(() => {
      const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set('version', DOCUMENT_SCHEMA_VERSION);
      map.set('nodes', { taskList: [] });
      map.set('marks', {});
    });

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );

    expect(result.current.intercepted).toBe(false);
  });
});

describe('版本号跟 meta 里的不一样：拦', () => {
  it('meta 里那份跟我不一样就拦 —— 摘要只有相等不相等，没有谁新谁旧', () => {
    const metaDoc = meta();
    publish(metaDoc, 'another-build');

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );

    expect(result.current.intercepted).toBe(true);
  });

  it('把服务器那份告诉界面用的发布时间带出来', () => {
    const metaDoc = meta();
    publish(metaDoc, 'another-build', '2026-08-13T06:20:00.000Z');

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );

    expect(result.current.publishedAt).toBe('2026-08-13T06:20:00.000Z');
  });

  it('meta 稍后才到（重连时收到）→ 到了就拦', () => {
    const metaDoc = meta();

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );
    expect(result.current.intercepted).toBe(false);

    act(() => publish(metaDoc, 'another-build'));

    expect(result.current.intercepted).toBe(true);
  });
});
