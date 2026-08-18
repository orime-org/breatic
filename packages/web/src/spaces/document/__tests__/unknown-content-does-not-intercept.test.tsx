// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 D1：只读拦截只认 meta 版本比对；撞见解析不了的内容
 * 只走兜底渲染、不触发只读。
 * 权威定稿：文档结构决议（2026-08-17，私有工程文档）§7
 * （user 2026-08-17 拍定，#117 就此解决）。
 *
 * 结构上判定已经读不到正文（钩子只收 metaDoc）——本文件把这个契约钉住：
 * 正文里真的躺着陌生内容时，判定照样只看版本。TDD 红灯阶段在旧实现
 * （mismatch || unknown.length > 0）上确认过第一条失败。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
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
  docs.splice(0).forEach((d) => {
    d.destroy();
  });
});

function pair(): { metaDoc: Y.Doc; bodyDoc: Y.Doc } {
  const metaDoc = new Y.Doc();
  const bodyDoc = new Y.Doc();
  docs.push(metaDoc, bodyDoc);
  return { metaDoc, bodyDoc };
}

function publish(metaDoc: Y.Doc, version: string = DOCUMENT_SCHEMA_VERSION): void {
  metaDoc.transact(() => {
    const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
    map.set('version', version);
    map.set('nodes', DOCUMENT_SCHEMA.nodes);
    map.set('marks', DOCUMENT_SCHEMA.marks);
    map.set('publishedAt', '2026-08-17T00:00:00.000Z');
  });
}

function seedUnknownBlock(bodyDoc: Y.Doc): void {
  const mystery = new Y.XmlElement('mysteryBlockFromANewerBuild');
  mystery.insert(0, [new Y.XmlText('content this build cannot resolve')]);
  documentBodyFragment(bodyDoc).push([mystery]);
}

describe('D1 只读拦截只认版本比对', () => {
  it('版本一致 + 文档含陌生内容：不拦截（陌生内容归兜底渲染管）', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc);
    seedUnknownBlock(bodyDoc);

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );
    expect(result.current.intercepted).toBe(false);
  });

  it('版本不一致：仍然拦截（保留的那一半判据）', () => {
    const { metaDoc } = pair();
    publish(metaDoc, '9999.0.0');

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc }),
    );
    expect(result.current.intercepted).toBe(true);
  });
});
