// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A press on a highlight opens the comment it belongs to (#18, A6 · A20).
 *
 * What is pinned here is which threads a press names, and that ALL of them are
 * named: two comments may cover the same run, and the library's own handler
 * reaches only the first. Where the comment then appears — in the panel or
 * floating beside the line — is the chrome's, and is held elsewhere.
 *
 * TDD: red because nothing answers a press on a highlight yet.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { CommentsExtension } from '@blocknote/core/comments';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';
import {
  hoverThread,
  onSelectedThreadsChange,
  selectThreads,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens a mounted editor with comments on, holding one line.
 * @returns The editor.
 */
function open(): Editor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha bravo charlie' },
  ] as never);
  return editor;
}

/** Where the first run of text sits. */
function firstRun(editor: Editor): { from: number; to: number } {
  let at: { from: number; to: number } | undefined;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText && at === undefined) {
      at = { from: pos, to: pos + node.nodeSize };
    }
    return true;
  });
  return at!;
}

/**
 * Comments on part of the first line.
 * @param editor - The editor.
 * @param from - How far into the line the comment starts.
 * @param to - Where it ends.
 * @returns The thread's id.
 */
async function comment(
  editor: Editor,
  from: number,
  to: number,
): Promise<string> {
  const run = firstRun(editor);
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, {
      from: run.from + from,
      to: run.from + to,
    }),
  );
  const thread = await postComment(editor, 'said something');
  return thread!.id;
}

/**
 * Presses the body at one offset into the first line.
 * @param editor - The editor.
 * @param at - How far into the line to press.
 * @returns Whether any handler in the chain answered it.
 */
function press(editor: Editor, at: number): boolean {
  const view = editor.prosemirrorView!;
  const pos = firstRun(editor).from + at;
  return (
    view.someProp('handleClick', (handler) =>
      handler(view, pos, new MouseEvent('mousedown', { button: 0 })),
    ) === true
  );
}

/** Which thread the library itself believes is being read. */
function librarySelection(editor: Editor): string | undefined {
  return (
    editor.getExtension(CommentsExtension) as unknown as {
      store: { state: { selectedThreadId?: string } };
    }
  ).store.state.selectedThreadId;
}

describe('pressing a highlight', () => {
  it('opens the comment it belongs to', async () => {
    const editor = open();
    const threadId = await comment(editor, 0, 5);

    press(editor, 2);

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([threadId]);
  });

  it('names both where two comments cover the same words', async () => {
    // A20: the library's handler takes the first mark it finds, so the second
    // thread would be unreachable. Both are named and the reader picks.
    const editor = open();
    const first = await comment(editor, 0, 11);
    const second = await comment(editor, 6, 19);

    press(editor, 8);

    expect(new Set(selectedThreadsIn(editor.prosemirrorState))).toEqual(
      new Set([first, second]),
    );
  });

  it('names only the one where the highlights do not overlap', async () => {
    const editor = open();
    const first = await comment(editor, 0, 5);
    await comment(editor, 6, 11);

    press(editor, 2);

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([first]);
  });

  it('closes what was open when the press lands on plain text', async () => {
    const editor = open();
    await comment(editor, 0, 5);
    press(editor, 2);

    press(editor, 14);

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([]);
  });

  it('keeps the selection while the body is edited under it', async () => {
    // The selection holds ids and no position, so an edit elsewhere has
    // nothing to invalidate.
    const editor = open();
    const threadId = await comment(editor, 6, 11);
    press(editor, 8);

    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('xx', firstRun(editor).from));

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([threadId]);
  });
});

describe('pressing a comment that is already open', () => {
  it('leaves the press for whoever else wants it', async () => {
    // Commented words can be a link as well, and the link handler sits behind
    // both comment handlers in the chain. The library answers this by standing
    // aside on a second press — its own comment says "let other handlers
    // process the event (e.g. navigating a link)" — and so does this.
    const editor = open();
    await comment(editor, 0, 5);

    expect(press(editor, 2)).toBe(true);
    expect(press(editor, 2)).toBe(false);
  });

  it('holds the comment open across that second press', async () => {
    const editor = open();
    const threadId = await comment(editor, 0, 5);

    press(editor, 2);
    press(editor, 2);

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([threadId]);
  });

  it('answers again once the reader presses a different comment', async () => {
    const editor = open();
    await comment(editor, 0, 5);
    const second = await comment(editor, 6, 11);
    press(editor, 2);

    expect(press(editor, 8)).toBe(true);
    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([second]);
  });

  it('tells the library which thread is being read, so it stands aside too', async () => {
    // The library keeps its own `selectedThreadId` and answers a press on any
    // thread that is not it. Left unwritten, its handler would take every
    // press this one lets through and the link would still never open.
    const editor = open();
    const threadId = await comment(editor, 0, 5);

    press(editor, 2);

    expect(librarySelection(editor)).toBe(threadId);
  });

  it('tells the library the reader has looked away', async () => {
    const editor = open();
    await comment(editor, 0, 5);
    press(editor, 2);

    press(editor, 14);

    expect(librarySelection(editor)).toBeUndefined();
  });
});

describe('selecting from elsewhere', () => {
  it('opens a thread the panel names', async () => {
    const editor = open();
    const threadId = await comment(editor, 0, 5);

    selectThreads(editor, [threadId]);

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([threadId]);
  });

  it('tells a listener when the selection opens and closes', () => {
    const editor = open();
    let heard = 0;
    const stop = onSelectedThreadsChange(() => {
      heard += 1;
    });

    selectThreads(editor, ['t1']);
    expect(heard).toBe(1);

    selectThreads(editor, []);
    expect(heard).toBe(2);

    stop();
    selectThreads(editor, ['t2']);
    expect(heard).toBe(2);
  });

  it('stays quiet when nothing was open and nothing is asked for', () => {
    const editor = open();
    let heard = 0;
    const stop = onSelectedThreadsChange(() => {
      heard += 1;
    });

    selectThreads(editor, []);
    stop();

    expect(heard).toBe(0);
  });
});

describe('resting on a card in the panel', () => {
  it('deepens that comment in the body', async () => {
    const editor = open();
    const threadId = await comment(editor, 0, 5);

    hoverThread(editor, threadId);

    const deepened = editor.domElement?.querySelector(
      '.doc-comment-mark-reading',
    );
    expect(deepened?.textContent).toBe('alpha');
  });

  it('lets it go again when the pointer leaves', async () => {
    const editor = open();
    const threadId = await comment(editor, 0, 5);
    hoverThread(editor, threadId);

    hoverThread(editor, null);

    expect(
      editor.domElement?.querySelector('.doc-comment-mark-reading'),
    ).toBeNull();
  });

  it('is not the same thing as having the comment open', async () => {
    // Resting on a card says where a reader is looking; it does not open
    // anything, and letting it go leaves an open comment open.
    const editor = open();
    const first = await comment(editor, 0, 5);
    const second = await comment(editor, 6, 11);
    press(editor, 2);

    hoverThread(editor, second);
    hoverThread(editor, null);

    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([first]);
  });

  it('deepens both while one is open and the pointer rests on another', async () => {
    const editor = open();
    const first = await comment(editor, 0, 5);
    const second = await comment(editor, 6, 11);
    press(editor, 2);

    hoverThread(editor, second);

    const deepened = [
      ...(editor.domElement?.querySelectorAll('.doc-comment-mark-reading') ??
        []),
    ].map((mark) => mark.textContent);
    expect(new Set(deepened)).toEqual(new Set(['alpha', 'bravo']));
    expect(first).not.toBe(second);
  });
});
