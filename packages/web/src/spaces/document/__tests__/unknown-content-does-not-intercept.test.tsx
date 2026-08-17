// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 D1：只读拦截只认 meta 版本比对；撞见解析不了的内容
 * 只走兜底渲染、不触发只读。
 * 权威定稿 inner engineering/decisions/2026-08-17-document-structure-dd.md §7
 * （user 2026-08-17 拍定，#117 就此解决）。
 *
 * TDD 红灯批次一：现实现是 `mismatch || unknown.length > 0` 两条件，
 * 「陌生内容不拦截」那条在旧世界必须红；「版本不一致仍拦截」钉住保留的一半。
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
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );
    expect(result.current.intercepted).toBe(false);
  });

  it('版本不一致：仍然拦截（保留的那一半判据）', () => {
    const { metaDoc, bodyDoc } = pair();
    publish(metaDoc, '9999.0.0');

    const { result } = renderHook(() =>
      useDocumentSchemaIntercept({ metaDoc, bodyDoc }),
    );
    expect(result.current.intercepted).toBe(true);
  });
});
