// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 B1 / B2 / B3 / B4 / B5：两档 Ctrl+A 与全文档选区的按键行为。
 * 权威定稿：文档结构决议（2026-08-17，私有工程文档）§10
 * 两张转移表；全文档删除走确认接缝（onClearDocumentRequest 回调 +
 * clearDocument 命令），确认对话框本体在组件层另测。
 *
 * TDD 红灯批次二：旧世界（标题块 + 按侧钳制）下本文件必须全红。
 * 两张表逐格在此钉齐：NodeSelection 与 GapCursor 行、零块行、修饰键
 * 删除和弦全家族（实现对抗第 1 轮补钉）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { GapCursor } from '@tiptap/pm/gapcursor';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

function openOn(
  doc: Y.Doc,
  onClearDocumentRequest?: () => void,
): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({
      fragment: documentBodyFragment(doc),
      onClearDocumentRequest,
    }),
  });
  editors.push(editor);
  return editor;
}

function openWithBlocks(onClearDocumentRequest?: () => void): Editor {
  const e = openOn(new Y.Doc(), onClearDocumentRequest);
  e.commands.setContent('<p>alpha</p><p>beta</p><p>gamma</p>');
  return e;
}

function press(
  e: Editor,
  key: string,
  modifiers: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  } = {},
): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  e.view.someProp('handleKeyDown', (f) => f(e.view, event));
}

/** jsdom 判成 pc 平台，Mod-a 即 Ctrl-a。 */
function pressSelectAll(e: Editor): void {
  press(e, 'a', { ctrlKey: true });
}

/** 把光标放进第 index 个块的文本里。 */
function caretIntoBlock(e: Editor, index: number): void {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += e.state.doc.child(i).nodeSize;
  e.view.dispatch(
    e.state.tr.setSelection(TextSelection.create(e.state.doc, pos + 2)),
  );
}

/** 第 index 个块的文本范围 [from, to]。 */
function blockTextRange(e: Editor, index: number): { from: number; to: number } {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += e.state.doc.child(i).nodeSize;
  const block = e.state.doc.child(index);
  return { from: pos + 1, to: pos + 1 + block.content.size };
}

describe('B1 两档 Ctrl+A', () => {
  it('光标在块内第一次按：选中当前块的全部文本', () => {
    const e = openWithBlocks();
    caretIntoBlock(e, 1);
    pressSelectAll(e);
    const { from, to } = blockTextRange(e, 1);
    expect(e.state.selection).toBeInstanceOf(TextSelection);
    expect(e.state.selection.from).toBe(from);
    expect(e.state.selection.to).toBe(to);
  });

  it('当前块已全选后第二次按：AllSelection 覆盖整个文档', () => {
    const e = openWithBlocks();
    caretIntoBlock(e, 1);
    pressSelectAll(e);
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });

  it('块内部分选区按一次：进第一档（当前块全选）', () => {
    const e = openWithBlocks();
    const { from } = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.create(e.state.doc, from, from + 2),
      ),
    );
    pressSelectAll(e);
    const range = blockTextRange(e, 1);
    expect(e.state.selection.from).toBe(range.from);
    expect(e.state.selection.to).toBe(range.to);
  });

  it('跨块选区按一次：直接全选整个文档', () => {
    const e = openWithBlocks();
    const first = blockTextRange(e, 0);
    const second = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.create(e.state.doc, first.from + 1, second.from + 1),
      ),
    );
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });

  it('全文档已选再按：不变', () => {
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
    expect(e.state.doc.childCount).toBe(3);
  });

  it('零块文档按：空操作不抛', () => {
    const e = openOn(new Y.Doc());
    expect(() => {
      pressSelectAll(e);
    }).not.toThrow();
    expect(e.state.doc.childCount).toBe(0);
  });
});

describe('B3 全文档删除走确认接缝', () => {
  it.each(['Backspace', 'Delete'])(
    '全文档选区按 %s：只发确认请求，文档不动',
    (key) => {
      const onClear = vi.fn();
      const e = openWithBlocks(onClear);
      e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
      press(e, key);
      expect(onClear).toHaveBeenCalledTimes(1);
      expect(e.state.doc.childCount).toBe(3);
      expect(e.getHTML()).toContain('alpha');
    },
  );

  it('跨块（非全文档）选区按 Backspace：照常删除，不发确认请求', () => {
    const onClear = vi.fn();
    const e = openWithBlocks(onClear);
    const first = blockTextRange(e, 0);
    const second = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.create(e.state.doc, first.from + 1, second.to - 1),
      ),
    );
    press(e, 'Backspace');
    expect(onClear).not.toHaveBeenCalled();
    expect(e.state.doc.textContent).not.toContain('beta');
  });

  it('clearDocument 命令：清空到零块，之后可再写', () => {
    const e = openWithBlocks();
    e.commands.clearDocument();
    expect(e.state.doc.childCount).toBe(0);
    e.commands.insertContent('again');
    expect(e.getHTML()).toBe('<p>again</p>');
  });
});

describe('B4 全文档回车：内容不动、文末追加空段落', () => {
  it('全选后按 Enter：三个块都在，第四个是空段落，光标落入', () => {
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    press(e, 'Enter');
    expect(e.state.doc.childCount).toBe(4);
    expect(e.getHTML()).toContain('alpha');
    expect(e.getHTML()).toContain('gamma');
    const last = e.state.doc.child(3);
    expect(last.type.name).toBe('paragraph');
    expect(last.content.size).toBe(0);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.from).toBe(e.state.doc.content.size - 1);
  });
});

describe('B2 全文档选区打字：替换为单段', () => {
  it('全选后插入字符：全文被替换成一个段落', () => {
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    e.commands.insertContent('x');
    expect(e.state.doc.childCount).toBe(1);
    expect(e.getHTML()).toBe('<p>x</p>');
  });
});

describe('B5 零块选区归一守卫', () => {
  it('零块文档：指向 doc 层的退化 TextSelection 被归一为 AllSelection', () => {
    const e = openOn(new Y.Doc());
    expect(e.state.doc.childCount).toBe(0);
    e.view.dispatch(
      e.state.tr.setSelection(Selection0(e)),
    );
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });

  it('空文档的静息 AllSelection 在内容到达后收拢成文首光标', () => {
    // AllSelection 经映射永远还是全文档——不收拢的话，空文档里静息的它
    // 会在协作者的第一段内容到达时静默变成「全选了那段内容」。
    const e = openOn(new Y.Doc());
    expect(e.state.selection).toBeInstanceOf(AllSelection);
    e.commands.setContent('<p>arrived</p>');
    expect(e.state.selection).not.toBeInstanceOf(AllSelection);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.isTextblock).toBe(true);
  });

  it('有内容的文档：退化 TextSelection 归一到最近光标位，不升格成全选', () => {
    // 升格会把「什么都没选」翻成「全选」——下一记 Backspace 就误触
    // 整篇删除的确认框（setContent 后的残留选区实测踩过这一步）。
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(Selection0(e)));
    expect(e.state.selection).toBeInstanceOf(TextSelection);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.isTextblock).toBe(true);
  });
});

describe('B1 NodeSelection 档（兜底块被整体选中时）', () => {
  it('NodeSelection 上按 Ctrl+A：全选整个文档', () => {
    const doc = new Y.Doc();
    const title = new Y.XmlElement('title');
    title.insert(0, [new Y.XmlText('old')]);
    documentBodyFragment(doc).push([title]);
    const e = openOn(doc);
    e.commands.insertContent('after');
    e.view.dispatch(
      e.state.tr.setSelection(NodeSelection.create(e.state.doc, 0)),
    );
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });
});

/**
 * 造一个指向 doc 层位置 0 的退化 TextSelection——E2a 告警与 E4c 残留
 * 的形态（零块文档里没有任何文本位置，TextSelection 指到 doc 上）。
 * @param e - 零块编辑器。
 * @returns 那个退化选区。
 */
function Selection0(e: Editor): TextSelection {
  return new TextSelection(e.state.doc.resolve(0));
}

describe('B2 修饰键删除和弦：全文档选区上一律先问（实现对抗第 1 轮 #1）', () => {
  // tiptap 内核把这些和弦各自直通删除命令（@tiptap/core dist/index.cjs
  // 的 baseKeymap / macKeymap），守卫只绑裸键名时它们全都绕过确认框。
  // 和弦清单照抄内核定义处，跟内核同一平台拆分。
  const PC_CHORDS: Array<[string, string, Parameters<typeof press>[2]]> = [
    ['Mod-Backspace', 'Backspace', { ctrlKey: true }],
    ['Shift-Backspace', 'Backspace', { shiftKey: true }],
    ['Mod-Delete', 'Delete', { ctrlKey: true }],
  ];
  PC_CHORDS.forEach(([name, key, mods]) => {
    it(`${name}：只问、不删`, () => {
      const asked = vi.fn();
      const e = openWithBlocks(asked);
      e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
      press(e, key, mods);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(e.state.doc.childCount).toBe(3);
    });
  });

  it('非全文档选区上和弦照常落回内核（块内选区照删、不问）', () => {
    const asked = vi.fn();
    const e = openWithBlocks(asked);
    const { from, to } = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)),
    );
    press(e, 'Backspace', { ctrlKey: true });
    expect(asked).not.toHaveBeenCalled();
    // 内核 Mod-Backspace 的 deleteSelection 删掉了块内选区——守卫答 false
    // 后和弦真的落回内核命令链。
    expect(e.state.doc.textContent).toBe('alphagamma');
  });
});

describe('B2 mac 档删除和弦（Ctrl-h 一类字母键和弦也要问）', () => {
  // 键表在编辑器构造时按 navigator.platform 拆分，这里按 mac 造一批。
  let restorePlatform: (() => void) | null = null;

  beforeEach(() => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
    Object.defineProperty(window.navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    restorePlatform = () => {
      if (original) Object.defineProperty(window.navigator, 'platform', original);
      else Reflect.deleteProperty(window.navigator, 'platform');
    };
  });
  afterEach(() => {
    restorePlatform?.();
    restorePlatform = null;
  });

  // Cmd-Backspace 不在此列：它跟 pc 档的 Ctrl-Backspace 是同一个
  // 'Mod-Backspace' 绑定名（prosemirror-keymap 的 Mod 归一按模块加载时的
  // navigator.platform 定死，测试进程里改不了），pc 档那行已钉住它。
  const MAC_CHORDS: Array<[string, string, Parameters<typeof press>[2]]> = [
    ['Ctrl-h', 'h', { ctrlKey: true }],
    ['Alt-Backspace', 'Backspace', { altKey: true }],
    ['Ctrl-d', 'd', { ctrlKey: true }],
    ['Ctrl-Alt-Backspace', 'Backspace', { ctrlKey: true, altKey: true }],
    ['Alt-Delete', 'Delete', { altKey: true }],
    ['Alt-d', 'd', { altKey: true }],
  ];
  MAC_CHORDS.forEach(([name, key, mods]) => {
    it(`${name}：只问、不删`, () => {
      const asked = vi.fn();
      const e = openWithBlocks(asked);
      e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
      press(e, key, mods);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(e.state.doc.childCount).toBe(3);
    });
  });
});

describe('clearDocument 只在可编辑的编辑器上执行（实现对抗第 1 轮 #2）', () => {
  it('只读编辑器上返回 false、文档一字不动', () => {
    const e = openWithBlocks();
    e.setEditable(false);
    expect(e.commands.clearDocument()).toBe(false);
    expect(e.state.doc.childCount).toBe(3);
  });
});

describe('B1/B2 NodeSelection 行的其余三格（占位块整体选中；A3 的「可删」也在这）', () => {
  /** 一个开头躺着兜底占位块的编辑器（存量 title 经补丁的形态）。 */
  function openWithStandIn(onClear?: () => void): Editor {
    const doc = new Y.Doc();
    doc.transact(() => {
      documentBodyFragment(doc).insert(0, [new Y.XmlElement('legacyBlock')]);
    });
    const e = openOn(doc, onClear);
    // 尾部显式插入——初始选区落在开头的原子块上，裸 insertContent 会把
    // 占位块整个替换掉。
    e.commands.insertContentAt(e.state.doc.content.size, '<p>after</p>');
    return e;
  }

  /** 选中第一个块（那个占位块）为 NodeSelection。 */
  function selectStandIn(e: Editor): void {
    e.view.dispatch(
      e.state.tr.setSelection(NodeSelection.create(e.state.doc, 0)),
    );
  }

  it('Backspace：删掉该块自己，不弹确认、别的块都在', () => {
    const asked = vi.fn();
    const e = openWithStandIn(asked);
    selectStandIn(e);
    press(e, 'Backspace');
    expect(asked).not.toHaveBeenCalled();
    expect(e.state.doc.childCount).toBe(1);
    expect(e.state.doc.textContent).toBe('after');
  });

  it('Delete：同样只删该块', () => {
    const asked = vi.fn();
    const e = openWithStandIn(asked);
    selectStandIn(e);
    press(e, 'Delete');
    expect(asked).not.toHaveBeenCalled();
    expect(e.state.doc.childCount).toBe(1);
  });

  it('打字：该块被替换成所打字符的段落', () => {
    const e = openWithStandIn();
    selectStandIn(e);
    e.commands.insertContent('x');
    expect(e.state.doc.childCount).toBe(2);
    expect(e.state.doc.child(0).type.name).toBe('paragraph');
    expect(e.state.doc.child(0).textContent).toBe('x');
  });

  it('Enter：createParagraphNear——块还在，旁边多一个空段、光标落入', () => {
    const e = openWithStandIn();
    selectStandIn(e);
    press(e, 'Enter');
    expect(e.state.doc.childCount).toBe(3);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph');
  });
});

describe('B1/B2 GapCursor 行（占位块旁的缝隙位）', () => {
  /** 编辑器 + 光标停在开头占位块前的缝隙。 */
  function openWithGap(onClear?: () => void): Editor {
    const doc = new Y.Doc();
    doc.transact(() => {
      documentBodyFragment(doc).insert(0, [new Y.XmlElement('legacyBlock')]);
    });
    const e = openOn(doc, onClear);
    e.commands.insertContentAt(e.state.doc.content.size, '<p>after</p>');
    e.view.dispatch(e.state.tr.setSelection(new GapCursor(e.state.doc.resolve(0))));
    return e;
  }

  it('缝隙位是可构造的合法选区', () => {
    const e = openWithGap();
    expect(e.state.selection).toBeInstanceOf(GapCursor);
  });

  it('Ctrl+A：直接全选整个文档', () => {
    const e = openWithGap();
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });

  it('Backspace / Delete：不弹确认框（守卫只管全文档档）', () => {
    const asked = vi.fn();
    const e = openWithGap(asked);
    press(e, 'Backspace');
    const f = openWithGap(asked);
    press(f, 'Delete');
    expect(asked).not.toHaveBeenCalled();
  });

  it('Enter：在缝隙处建段落', () => {
    const e = openWithGap();
    press(e, 'Enter');
    expect(e.state.doc.child(0).type.name).toBe('paragraph');
    expect(e.state.doc.childCount).toBe(3);
  });
});

describe('B2 零块行的 Backspace / Enter 格：空操作', () => {
  it.each(['Backspace', 'Delete', 'Enter'])('零块文档按 %s：吞键、不弹、不变', (key) => {
    const asked = vi.fn();
    const e = openOn(new Y.Doc(), asked);
    expect(e.state.doc.childCount).toBe(0);
    press(e, key);
    expect(asked).not.toHaveBeenCalled();
    expect(e.state.doc.childCount).toBe(0);
  });
});

describe('B3 非键盘删除通道也要问：beforeinput 的 delete 类输入（实现对抗第 2 轮 #2）', () => {
  // 浏览器菜单删除（macOS Edit→Delete、Firefox 右键 Delete）不经 keydown：
  // 原生删掉 DOM 后由 ProseMirror 的 DOMObserver 读回成普通事务，键表守卫
  // 看不见。桌面端 prosemirror-view 的 beforeinput 只处理 Android，这一层
  // 由我们自己接。剪切（deleteByCut）与拖拽（deleteByDrag）按拍定不设防。
  /** 直接打进扩展的 beforeinput 处理器，返回处理器答没答 true。 */
  function fireBeforeInput(e: Editor, inputType: string): { handled: boolean; prevented: boolean } {
    const event = new InputEvent('beforeinput', { inputType, cancelable: true });
    const handled = !!e.view.someProp('handleDOMEvents', (handlers) =>
      handlers.beforeinput?.(e.view, event),
    );
    return { handled, prevented: event.defaultPrevented };
  }

  it.each(['deleteContentBackward', 'deleteContentForward', 'deleteContent', 'deleteWordBackward'])(
    '全文档选区上 %s：拦下、只问、不删',
    (inputType) => {
      const asked = vi.fn();
      const e = openWithBlocks(asked);
      e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
      const { handled, prevented } = fireBeforeInput(e, inputType);
      expect(handled).toBe(true);
      expect(prevented).toBe(true);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(e.state.doc.childCount).toBe(3);
    },
  );

  it('deleteByCut：放行不问（剪切归入不设防家族，user 2026-08-18 拍 A）', () => {
    const asked = vi.fn();
    const e = openWithBlocks(asked);
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    const { handled } = fireBeforeInput(e, 'deleteByCut');
    expect(handled).toBe(false);
    expect(asked).not.toHaveBeenCalled();
  });

  it('非全文档选区上 delete 类输入：放行不问', () => {
    const asked = vi.fn();
    const e = openWithBlocks(asked);
    caretIntoBlock(e, 1);
    const { handled } = fireBeforeInput(e, 'deleteContentBackward');
    expect(handled).toBe(false);
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('B2 补齐最后三格：块内与跨块选区的打字、块内选区的回车（实现对抗第 2 轮 #6）', () => {
  // 这三格由 ProseMirror 默认与 DocumentSplitBlock 提供，行为今天就是对的；
  // 钉住是因为 DocumentSelectAll 以 1000 优先级绑着同一批键，将来在绑定上
  // 加分支时错拦这些选区不会有别的测试变红。打字格沿用全文档行的手法
  // （insertContent 钉替换语义），回车格走真实按键路径。
  it('块内文本选区打字：选中的字被替换，别的块不动', () => {
    const e = openWithBlocks();
    const { from, to } = blockTextRange(e, 1);
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)));
    e.commands.insertContent('x');
    expect(e.state.doc.childCount).toBe(3);
    expect(e.state.doc.child(1).textContent).toBe('x');
    expect(e.state.doc.child(0).textContent).toBe('alpha');
  });

  it('跨块选区打字：替换并合并端点块', () => {
    const e = openWithBlocks();
    const first = blockTextRange(e, 0);
    const second = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.create(e.state.doc, first.from + 2, second.to - 2),
      ),
    );
    e.commands.insertContent('x');
    expect(e.state.doc.childCount).toBe(2);
    expect(e.state.doc.child(0).textContent).toBe('alxta');
    expect(e.state.doc.child(1).textContent).toBe('gamma');
  });

  it('块内文本选区按 Enter：删除选区后在那里分块', () => {
    const e = openWithBlocks();
    const { from, to } = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(TextSelection.create(e.state.doc, from + 1, to - 1)),
    );
    press(e, 'Enter');
    expect(e.state.doc.childCount).toBe(4);
    expect(e.state.doc.child(1).textContent).toBe('b');
    expect(e.state.doc.child(2).textContent).toBe('a');
  });
});
