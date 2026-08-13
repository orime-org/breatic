// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `DOCUMENT_SCHEMA` 那份清单是手写的，因为 collab 那边建不出 ProseMirror
 * schema —— 它没有编辑器。这条测试把真实的 schema 建出来跟它比。
 *
 * 少了这条，「加一个扩展 / 给某个节点加一个属性」的人不会有任何理由去打开
 * shared 那个文件，而清单没跟上时判定照样通过、遮罩永远不出现，没有任何
 * 报错说得出哪儿不对（Gate 1 第四轮 direction-1）。
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { DOCUMENT_SCHEMA } from '@breatic/shared';
import * as Y from 'yjs';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

/**
 * 把真实 schema 摊成跟 `DOCUMENT_SCHEMA` 同一个形状。
 * @returns 节点和标记各自的名字，以及每个的属性名（已排序）。
 */
function realSchemaShape(): {
  nodes: Record<string, string[]>;
  marks: Record<string, string[]>;
  } {
  const doc = new Y.Doc();
  try {
    const schema = getSchema(
      buildDocumentExtensions({
        fragment: doc.getXmlFragment('body'),
        caretProvider: null,
        undoManager: undefined,
        resolveCollaboratorName: () => null,
      }),
    );
    /**
     * 摊平一侧（节点或标记）。
     * @param types - schema 的 nodes 或 marks。
     * @returns 名字到属性名数组。
     */
    const flatten = (
      types: Record<string, { spec: { attrs?: Record<string, unknown> } }>,
    ): Record<string, string[]> =>
      Object.fromEntries(
        Object.entries(types).map(([name, type]) => [
          name,
          Object.keys(type.spec.attrs ?? {}).sort(),
        ]),
      );
    return { nodes: flatten(schema.nodes), marks: flatten(schema.marks) };
  } finally {
    doc.destroy();
  }
}

describe('手写的那份清单跟真实 schema', () => {
  it('节点：名字和属性名逐个对得上', () => {
    const real = realSchemaShape();
    expect(real.nodes).toEqual(
      Object.fromEntries(
        Object.entries(DOCUMENT_SCHEMA.nodes).map(([n, a]) => [n, [...a]]),
      ),
    );
  });

  it('标记：名字和属性名逐个对得上', () => {
    const real = realSchemaShape();
    expect(real.marks).toEqual(
      Object.fromEntries(
        Object.entries(DOCUMENT_SCHEMA.marks).map(([n, a]) => [n, [...a]]),
      ),
    );
  });
});
