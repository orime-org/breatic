// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 F1-F4：`block*` 世界的协作与撤销（Yjs 关键路径，100% 覆盖）。
 * 权威定稿：文档结构决议（2026-08-17，私有工程文档）§4.3 / §4.4 / §4.6
 * —— 断言形态照 #121 探针 E2 / E4 / E6 的实测结果钉死
 * （探针存档在私有工程文档，本文件是它们的正式化）。
 *
 * TDD 红灯批次二：旧世界（标题块）下这些流程走不出实测形态，必须红。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { AllSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { createDocumentUndoManager } from '@web/spaces/document/document-undo';

interface Client {
  editor: Editor;
  undo: () => void;
  redo: () => void;
  stopCapturing: () => void;
}

const clients: Client[] = [];

afterEach(() => {
  clients.splice(0).forEach((c) => {
    c.editor.destroy();
  });
});

function openOn(doc: Y.Doc): Client {
  const undoManager = createDocumentUndoManager(doc);
  const editor = new Editor({
    extensions: buildDocumentExtensions({
      fragment: documentBodyFragment(doc),
      undoManager,
    }),
  });
  const client: Client = {
    editor,
    undo: () => undoManager.undo(),
    redo: () => undoManager.redo(),
    stopCapturing: () => undoManager.stopCapturing(),
  };
  clients.push(client);
  return client;
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('F1 两人各自在空文档建段', () => {
  it('合并后两侧都是两段，各自的字都在', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = openOn(docA);
    const b = openOn(docB);
    a.editor.commands.insertContent('A');
    b.editor.commands.insertContent('B');
    sync(docA, docB);
    expect(a.editor.state.doc.childCount).toBe(2);
    expect(b.editor.getHTML()).toBe(a.editor.getHTML());
    expect(a.editor.getHTML()).toContain('<p>A</p>');
    expect(a.editor.getHTML()).toContain('<p>B</p>');
  });
});

describe('F2 两人并发清空文档', () => {
  it('两侧收敛零块，之后可再写', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = openOn(docA);
    a.editor.commands.setContent('<p>one</p><p>two</p>');
    const b = openOn(docB);
    sync(docA, docB);
    a.editor.commands.clearDocument();
    b.editor.commands.clearDocument();
    sync(docA, docB);
    expect(a.editor.state.doc.childCount).toBe(0);
    expect(b.editor.state.doc.childCount).toBe(0);
    a.editor.commands.insertContent('again');
    sync(docA, docB);
    expect(b.editor.getHTML()).toBe('<p>again</p>');
  });
});

describe('F3 撤销穿越零块态', () => {
  it('清空后 undo 找回两段、redo 再删空', () => {
    const doc = new Y.Doc();
    const c = openOn(doc);
    c.editor.commands.setContent('<p>a</p><p>b</p>');
    c.stopCapturing();
    c.editor.commands.clearDocument();
    expect(c.editor.state.doc.childCount).toBe(0);
    c.undo();
    expect(c.editor.getHTML()).toBe('<p>a</p><p>b</p>');
    c.redo();
    expect(c.editor.state.doc.childCount).toBe(0);
  });

  it('空文档写入后 undo 回到零块、redo 找回', () => {
    const doc = new Y.Doc();
    const c = openOn(doc);
    c.editor.commands.insertContent('hello');
    c.undo();
    expect(c.editor.state.doc.childCount).toBe(0);
    c.redo();
    expect(c.editor.getHTML()).toBe('<p>hello</p>');
  });
});

describe('F3b 撤销清空后，删除前的全文档选区一并恢复（实现对抗第 1 轮 #4）', () => {
  it('undo 找回内容时选区回到 AllSelection，不被归一守卫收拢', () => {
    // 归一守卫的空→非空收拢分支是为「远程内容到达空文档」写的；undo 的
    // 恢复事务同样从零块起步、终态带回删除前的 AllSelection——把它一并
    // 收拢等于把用户删除前的选区偷换成文首光标。按 y-undo 来源放行。
    const doc = new Y.Doc();
    const a = openOn(doc);
    a.editor.commands.setContent('<p>alpha</p><p>beta</p>');
    a.stopCapturing();
    a.editor.view.dispatch(
      a.editor.state.tr.setSelection(new AllSelection(a.editor.state.doc)),
    );
    a.editor.commands.clearDocument();
    expect(a.editor.state.doc.childCount).toBe(0);

    a.undo();
    expect(a.editor.state.doc.childCount).toBe(2);
    expect(a.editor.state.selection).toBeInstanceOf(AllSelection);
    expect(a.editor.state.selection.from).toBe(0);
    expect(a.editor.state.selection.to).toBe(a.editor.state.doc.content.size);
  });
});

describe('F4 A 清空卷走 B 的并发输入后，A 的撤销恢复删除前正文', () => {
  it('A undo 找回自己删掉的内容（B 被卷走的字不在任何栈里，已拍接受）', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = openOn(docA);
    a.editor.commands.setContent('<p>hello</p>');
    a.stopCapturing();
    const b = openOn(docB);
    sync(docA, docB);
    b.stopCapturing();
    a.editor.commands.clearDocument();
    b.editor.commands.focus('end');
    b.editor.commands.insertContent('!');
    sync(docA, docB);
    expect(a.editor.state.doc.childCount).toBe(0);
    a.undo();
    sync(docA, docB);
    expect(a.editor.getHTML()).toBe('<p>hello</p>');
    expect(b.editor.getHTML()).toBe('<p>hello</p>');
  });
});
