// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 拦截覆盖**每一个已打开的 document tab**，不只当前看着的那一个（验收 15）。
 *
 * 为什么这条要单独测：拦截判定原先住在 `DocumentSpace` 里，而 `DocumentSpace`
 * 只对**激活**的那个 Space 渲染（`ProjectPage` 的 `SpaceOutlet` 按 activeSpace
 * 挂载）；而编辑器是按文档缓存的、**故意活过 tab 切换**。两者作用域对不上：
 * 切走之后那份文档的编辑器还绑在 Y.Doc 上收远程更新，却没有任何东西去销毁它。
 *
 * 而验收 14 选 `destroy()` 而不是 `setEditable(false)`，全部理由就是「存在的
 * 编辑器本身就会污染共享文档」——那个理由对切走的那些 space 同样成立。
 *
 * `SpaceDocSync` 是对**每个已打开 tab** 挂一个的，作用域正好。
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { DOCUMENT_SCHEMA_META_KEY } from '@breatic/shared';
import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_VERSION,
} from '@web/spaces/document/document-schema';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { SpaceDocSync } from '@web/pages/project/SpaceDocSync';
import {
  getDocumentEditor,
  _resetDocumentEditorCacheForTests,
} from '@web/spaces/document/document-editor-cache';

const socketAwareness = new Awareness(new Y.Doc());
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): { provider: { awareness: unknown }; hasEverSynced: boolean } => ({
    provider: { awareness: socketAwareness },
    hasEverSynced: true,
  }),
}));

const PID = 'p-bg';
const SID = 's-bg';

beforeEach(() => {
  _resetDocumentEditorCacheForTests();
  _resetForTests();
});

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  _resetForTests();
});

/**
 * 往 meta 里发布一份跟这个 build 不一样的清单（条件一）。
 * @param metaDoc - project 的 meta 文档。
 */
function publishDifferent(metaDoc: Y.Doc): void {
  metaDoc.transact(() => {
    const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
    map.set('version', 'another-build');
    map.set('nodes', DOCUMENT_SCHEMA.nodes);
    map.set('marks', DOCUMENT_SCHEMA.marks);
    map.set('publishedAt', '2026-08-13T06:20:00.000Z');
  });
}

describe('一个开着但没在看的 document tab', () => {
  it('服务器换了 schema，它的编辑器也被销毁', () => {
    const name = docName.documentSpace(PID, SID);
    const bodyDoc = getDoc(name);
    const metaDoc = getDoc(docName.projectMeta(PID));

    // 这个 tab 之前被看过，所以编辑器已经在缓存里、还绑着这份文档。
    const handle = getDocumentEditor(bodyDoc, name, {
      caretProvider: { awareness: socketAwareness } as never,
      editable: true,
    });
    expect(handle.editor.isDestroyed).toBe(false);

    publishDifferent(metaDoc);

    // 现在用户在看别的 Space，所以 DocumentSpace 没有挂载 —— 只有这个。
    render(<SpaceDocSync projectId={PID} spaceId={SID} type='document' />);

    expect(handle.editor.isDestroyed).toBe(true);
  });

  it('服务器那份跟我一样时，不碰它的编辑器', () => {
    const name = docName.documentSpace(PID, 's-ok');
    const bodyDoc = getDoc(name);
    const metaDoc = getDoc(docName.projectMeta(PID));
    metaDoc.transact(() => {
      const map = metaDoc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set('version', DOCUMENT_SCHEMA_VERSION);
      map.set('nodes', DOCUMENT_SCHEMA.nodes);
      map.set('marks', DOCUMENT_SCHEMA.marks);
    });

    const handle = getDocumentEditor(bodyDoc, name, {
      caretProvider: { awareness: socketAwareness } as never,
      editable: true,
    });

    render(<SpaceDocSync projectId={PID} spaceId='s-ok' type='document' />);

    expect(handle.editor.isDestroyed).toBe(false);
  });
});
