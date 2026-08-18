// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 B3 的组件半边：全文档选区上的删除先问、确认才清、取消不动。
 * 权威定稿：文档结构决议（2026-08-17，私有工程文档）§9 / §10
 * （依据段含 NN/g 出处与范围收窄理由）。
 *
 * 真实键盘路径驱动（keydown 打进 ProseMirror 的 DOM），对话框走
 * components/ui 的 AlertDialog。TDD 红灯阶段确认过：接线缺失时按删除键
 * 被扩展吞掉（不弹不删），三条全红。
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { t } from '@breatic/shared';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { DocumentSpace } from '@web/spaces/document/DocumentSpace';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@breatic/shared';
import { useCurrentUserStore } from '@web/stores/current-user';

const socketAwareness = new Awareness(new Y.Doc());
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: { awareness: unknown };
    synced: boolean;
    hasEverSynced: boolean;
    status: string;
    writeAccess: string;
    authFailedReason: string | null;
  } => ({
    provider: { awareness: socketAwareness },
    synced: true,
    hasEverSynced: true,
    status: 'connected',
    writeAccess: 'granted',
    authFailedReason: null,
  }),
}));

describe('the whole-document delete asks first', () => {
  beforeEach(() => {
    useCurrentUserStore.setState({
      user: {
        id: 'user-1',
        name: 'Tester',
        email: 'tester@example.com',
      } as ReturnType<typeof useCurrentUserStore.getState>['user'],
    });
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    _resetForTests();
    useCurrentUserStore.setState({ user: null });
  });

  /**
   * Mount a document Space whose shared fragment holds the given paragraphs.
   * @param spaceId - The Space to mount.
   * @param texts - One paragraph per entry.
   * @returns The fragment and the editor's contenteditable element.
   */
  async function mountWith(
    spaceId: string,
    texts: string[],
  ): Promise<{ fragment: Y.XmlFragment; pm: HTMLElement }> {
    const doc = getDoc(docName.documentSpace('p1', spaceId));
    const fragment = documentBodyFragment(doc);
    doc.transact(() => {
      texts.forEach((text) => {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText(text)]);
        fragment.push([p]);
      });
    });
    render(<DocumentSpace projectId='p1' spaceId={spaceId} />);
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );
    const pm = document.querySelector('.ProseMirror') as HTMLElement;
    return { fragment, pm };
  }

  /** 两档 Ctrl+A 到全文档，再按删除。 */
  function selectAllThenDelete(pm: HTMLElement): void {
    fireEvent.keyDown(pm, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(pm, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(pm, { key: 'Backspace' });
  }

  it('按下删除只弹确认框，文档一个字不动', async () => {
    const { fragment, pm } = await mountWith('doc-ask', ['alpha', 'beta']);
    selectAllThenDelete(pm);

    expect(
      await screen.findByText(t('spaces.document.clearConfirm.title')),
    ).toBeInTheDocument();
    expect(fragment.length).toBe(2);
  });

  it('取消：对话框关掉，内容原样', async () => {
    const { fragment, pm } = await mountWith('doc-cancel', ['alpha', 'beta']);
    selectAllThenDelete(pm);
    const cancel = await screen.findByText(
      t('spaces.document.clearConfirm.cancel'),
    );
    fireEvent.click(cancel);

    await waitFor(() =>
      expect(
        screen.queryByText(t('spaces.document.clearConfirm.title')),
      ).not.toBeInTheDocument(),
    );
    expect(fragment.length).toBe(2);
  });

  it('确认：清空到零块', async () => {
    const { fragment, pm } = await mountWith('doc-confirm', ['alpha', 'beta']);
    selectAllThenDelete(pm);
    const confirm = await screen.findByText(
      t('spaces.document.clearConfirm.confirm'),
    );
    fireEvent.click(confirm);

    await waitFor(() => expect(fragment.length).toBe(0));
  });
});
