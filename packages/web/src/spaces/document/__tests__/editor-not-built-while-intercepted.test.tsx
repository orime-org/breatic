// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 拦截成立时，编辑器**根本不被创建**；已经建好的被销毁掉（验收 14、15）。
 *
 * 为什么不是「建好但设成只读」：实测过，`setEditable(false)` 在根节点内容
 * 规则漂移的场景下会把本地补出来的空壳写回共享文档，并让跑着新版本的人
 * 抛 `RangeError`。销毁两个场景都不写回、不抛。
 *
 * 为什么不是「盖一层」：那层东西只答鼠标，焦点还在 contenteditable 里，
 * 键盘照样把字打进共享文档。
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';

const docs: Y.Doc[] = [];

beforeEach(() => {
  _resetDocumentEditorCacheForTests();
});

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  awarenesses.splice(0).forEach((a) => a.destroy());
  docs.splice(0).forEach((d) => d.destroy());
});

const awarenesses: Awareness[] = [];

/**
 * 造一份文档，外加一个真的 awareness —— caret 扩展会调它的方法，
 * 替身糊弄不过去。
 * @returns 文档、它的名字，以及给编辑器用的 caret provider。
 */
function make(): {
  doc: Y.Doc;
  name: string;
  caretProvider: { awareness: Awareness };
  } {
  const doc = new Y.Doc();
  docs.push(doc);
  const awareness = new Awareness(doc);
  awarenesses.push(awareness);
  return {
    doc,
    name: 'project.p1.space.s1.document',
    caretProvider: { awareness },
  };
}

describe('拦截成立时', () => {
  it('一开始就成立 → 编辑器根本不被创建', () => {
    const { doc, name, caretProvider } = make();

    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name, caretProvider, enabled: false }),
    );

    expect(result.current).toBeNull();
  });

  it('先建好了、后来才成立 → 那个实例被销毁', () => {
    const { doc, name, caretProvider } = make();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useDocumentEditor({ doc, name, caretProvider, enabled }),
      { initialProps: { enabled: true } },
    );

    const built = result.current?.editor;
    expect(built).toBeDefined();
    expect(built?.isDestroyed).toBe(false);

    rerender({ enabled: false });

    expect(result.current).toBeNull();
    expect(built?.isDestroyed).toBe(true);
  });

  it('销毁之后再渲染，也不会又建一个出来', () => {
    const { doc, name, caretProvider } = make();

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useDocumentEditor({ doc, name, caretProvider, enabled }),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    rerender({ enabled: false });

    expect(result.current).toBeNull();
  });
});

describe('拦截不成立时', () => {
  it('照常创建', () => {
    const { doc, name, caretProvider } = make();

    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name, caretProvider, enabled: true }),
    );

    expect(result.current?.editor).toBeDefined();
    expect(result.current?.editor.isDestroyed).toBe(false);
  });

  it('不传这个参数就是照常创建——既有调用方一个字都不用改', () => {
    const { doc, name, caretProvider } = make();

    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name, caretProvider }),
    );

    expect(result.current?.editor).toBeDefined();
  });
});
