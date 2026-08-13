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
 * @param metaDoc - meta 文档。
 * @param shape - 要发布的清单；不给就发布跟本 build 一样的。
 * @param publishedAt - 发布时间。
 */
function publish(
  metaDoc: Y.Doc,
  shape: { nodes: unknown; marks: unknown } = DOCUMENT_SCHEMA,
  publishedAt = '2026-08-13T06:20:00.000Z',
): void {
  metaDoc.transact(() => {
    const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
    map.set('nodes', shape.nodes);
    map.set('marks', shape.marks);
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

describe('条件一：跟 meta 里那份不一样', () => {
  it('服务器多了一个节点类型 → 拦', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc, {
      nodes: { ...DOCUMENT_SCHEMA.nodes, taskList: [] },
      marks: DOCUMENT_SCHEMA.marks,
    });

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(true);
  });

  it('服务器少了一个节点类型（回滚方向）→ 一样拦', () => {
    const { metaDoc, bodyDoc } = pair();
    const fewer = { ...DOCUMENT_SCHEMA.nodes };
    delete (fewer as Record<string, unknown>).blockquote;
    publish(metaDoc, { nodes: fewer, marks: DOCUMENT_SCHEMA.marks });

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(true);
  });

  it('已知节点多了一个属性 → 拦（这一类兜底看不见）', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc, {
      nodes: { ...DOCUMENT_SCHEMA.nodes, heading: ['align', 'level'] },
      marks: DOCUMENT_SCHEMA.marks,
    });

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );

    expect(result.current.intercepted).toBe(true);
  });

  it('把服务器那份告诉界面用的发布时间带出来', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(
      metaDoc,
      { nodes: { ...DOCUMENT_SCHEMA.nodes, taskList: [] }, marks: DOCUMENT_SCHEMA.marks },
      '2026-08-13T06:20:00.000Z',
    );

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

    act(() => {
      publish(metaDoc, {
        nodes: { ...DOCUMENT_SCHEMA.nodes, taskList: [] },
        marks: DOCUMENT_SCHEMA.marks,
      });
    });

    expect(result.current.intercepted).toBe(true);
  });
});

describe('条件二：这份文档里有解析不了的内容', () => {
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
