// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 两个条件合起来的拦截判定（验收 12、13、15）。
 *
 * 判定**从两个 Yjs 文档派生**，不存任何本地状态：切 Space tab 走一圈回来，
 * 组件重挂载、重新派生一次，算出的是同一个答案。设计文档原本写的是「存进
 * store，免得切 tab 丢掉」——派生的东西没有可丢的，那个 store 是多余的。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  documentBodyFragment,
} from '@breatic/shared';

import { useDocumentSchemaIntercept } from '@web/spaces/document/use-document-schema-intercept';

const docs: Y.Doc[] = [];

afterEach(() => {
  docs.splice(0).forEach((d) => d.destroy());
});

/**
 * 造一对文档：project 的 meta，和某个 document space 的正文。
 * @returns 两个文档。
 */
function pair(): { metaDoc: Y.Doc; bodyDoc: Y.Doc } {
  const metaDoc = new Y.Doc();
  const bodyDoc = new Y.Doc();
  docs.push(metaDoc, bodyDoc);
  return { metaDoc, bodyDoc };
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

/**
 * 往正文里塞一个这个 build 不认识的块。
 *
 * 走 `documentBodyFragment`，不写字面量的键名 —— 正文住在哪个片段只有
 * `@breatic/shared` 那一处说了算，它故意不导出那个键名常量，就是为了不出现
 * 第二个给它起名字的地方。测试自己抄一个，抄错了就跟实现一起错、然后一起绿。
 * @param bodyDoc - 正文文档。
 */
function insertUnknownBlock(bodyDoc: Y.Doc): void {
  bodyDoc.transact(() => {
    documentBodyFragment(bodyDoc).insert(0, [new Y.XmlElement('taskList')]);
  });
}

describe('两个条件都不成立', () => {
  it('meta 里那份跟我一样、文档里也没有不认识的东西 → 不拦', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc);

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(false);
  });

  it('meta 里根本还没有那个键 → 不拦（没有信息不等于不一致）', () => {
    const { metaDoc, bodyDoc } = pair();

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(false);
  });
});

describe('条件一：版本号跟 meta 里的不一样', () => {
  it('meta 里那份跟我不一样就拦 —— 摘要只有相等不相等，没有谁新谁旧', () => {
    // 这里只有一条，不是两条。版本号是两张清单的摘要，两个摘要之间不存在
    // 「谁更新」这个属性，所以造不出「服务器那一版更旧」这个输入 —— 早先
    // 那两条用例名各写一个方向，用例体却逐字相同，第二条什么都没测到。
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc, 'another-build');

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(true);
  });

  it('版本号一样时，清单内容不管长什么样都不拦', () => {
    // 判定只看版本号。清单跟着版本号一起发布，它自己不参与比较 ——
    // 而版本号就是这两张清单的摘要，改了清单它自己就变，没有要人记得改的
    // 数字。
    const { metaDoc, bodyDoc } = pair();
    metaDoc.transact(() => {
      const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set('version', DOCUMENT_SCHEMA_VERSION);
      map.set('nodes', { taskList: [] });
      map.set('marks', {});
    });

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(false);
  });

  it('把服务器那份告诉界面用的发布时间带出来', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc, 'another-build', '2026-08-13T06:20:00.000Z');

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.publishedAt).toBe('2026-08-13T06:20:00.000Z');
  });

  it('meta 稍后才到（重连时收到）→ 到了就拦', () => {
    const { metaDoc, bodyDoc } = pair();

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );
    expect(result.current.intercepted).toBe(false);

    act(() => publish(metaDoc, 'another-build'));

    expect(result.current.intercepted).toBe(true);
  });
});

describe('条件二：这份文档里有解析不了的内容', () => {
  it('只有条件二成立时，发布时间照样给 —— 它说的是服务器那份什么时候发的', () => {
    // 那个时间是 `DOCUMENT_SCHEMA` 里人写的、服务器原样发布出来的，说的是「服务器现在
    // 跑的这一份是什么时候出的」。哪个条件触发的都不影响这句话为真，所以不
    // 按条件掐掉它 —— 掐掉会让面板按触发条件变成两套说法。
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc, DOCUMENT_SCHEMA_VERSION, '2026-01-01T00:00:00.000Z');
    insertUnknownBlock(bodyDoc);

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(true);
    expect(result.current.publishedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('文档里有不认识的块 → 拦，哪怕 meta 说我们一样', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc);
    insertUnknownBlock(bodyDoc);

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(true);
  });

  it('不认识的内容是协作中途到的 → 到了就拦', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc);

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );
    expect(result.current.intercepted).toBe(false);

    act(() => insertUnknownBlock(bodyDoc));

    expect(result.current.intercepted).toBe(true);
  });
});

describe('重挂载（切 Space tab 走一圈回来）', () => {
  it('重新派生出同一个答案，不需要任何存下来的状态', () => {
    const { metaDoc, bodyDoc } = pair();
    insertUnknownBlock(bodyDoc);

    const first = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );
    expect(first.result.current.intercepted).toBe(true);
    first.unmount();

    const second = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );
    expect(second.result.current.intercepted).toBe(true);
  });
});
