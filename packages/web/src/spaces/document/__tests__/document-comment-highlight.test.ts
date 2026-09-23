// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The highlight a comment leaves in the body (#18, A1 · A2 · A8 · A20).
 *
 * Half of what the task asks for is that a comment is visible where it was
 * made. The mark carrying the thread id is the library's; what it looks like
 * is ours, and nothing else in the stylesheet paints `bn-thread-mark`.
 *
 * TWO READINGS, BECAUSE NEITHER ALONE HOLDS IT. The document says the mark is
 * on the right words and carries the right thread; the stylesheet says it is
 * painted at all. With the paint taken out the whole unit suite stays green,
 * which is exactly the defect — a comment nobody can see.
 *
 * Resolved threads keep their mark and lose their paint: the library sets
 * `orphan` on a mark whose thread is resolved or gone (`comments/extension.ts:138-142`),
 * and the position it holds is what brings the highlight back when the thread
 * is reopened (§9.2, S2).
 *
 * TDD: red because nothing paints the mark yet.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';
import {
  declarationsOf,
  ruleBody,
} from '@web/spaces/document/__tests__/index-css-rules';

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

/** Every highlight currently in the body. */
function marks(editor: Editor): HTMLElement[] {
  return [
    ...(editor.domElement?.querySelectorAll<HTMLElement>('.bn-thread-mark') ??
      []),
  ];
}

describe('the highlight in the body', () => {
  it('lands on the words the comment is about, carrying its thread', async () => {
    const editor = open();
    const threadId = await comment(editor, 0, 5);

    const painted = marks(editor);
    expect(painted).toHaveLength(1);
    expect(painted[0]?.textContent).toBe('alpha');
    expect(painted[0]?.getAttribute('data-bn-thread-id')).toBe(threadId);
  });

  it('leaves the rest of the line alone', async () => {
    const editor = open();
    await comment(editor, 0, 5);

    expect(editor.domElement?.textContent).toBe('alpha bravo charlie');
  });

  it('nests where two comments overlap, so both are on the same words', async () => {
    // A20: overlapping is allowed — the mark's `excludes: ""` is what permits
    // it. Measured, the shared words land INSIDE both marks rather than in two
    // spans side by side, and that nesting is what deepens their colour: two
    // translucent layers over the same text.
    const editor = open();
    const first = await comment(editor, 0, 11);
    const second = await comment(editor, 6, 19);

    const inner = marks(editor).find((mark) => mark.textContent === 'bravo');
    expect(inner?.getAttribute('data-bn-thread-id')).toBe(second);
    const outer = inner?.parentElement;
    expect(outer?.classList.contains('bn-thread-mark')).toBe(true);
    expect(outer?.getAttribute('data-bn-thread-id')).toBe(first);
  });
});

describe('what the highlight looks like', () => {
  const MARK = '.doc-body .bn-thread-mark';

  /** The class our decoration carries, outside the library's namespace. */
  const READING_CLASS = 'doc-comment-mark-reading';

  it('is painted, which is the whole of "there is a mark here"', () => {
    expect(ruleBody(MARK)).toContain(
      'background-color: var(--color-comment-mark)',
    );
  });

  it('says it can be pressed while a press on it opens the thread', () => {
    // The same condition `document-comment-hit.ts` asks: a press reaches a
    // thread only while the mark it lands on is not orphaned.
    expect(ruleBody(`${MARK}:not([data-orphan='true'])`)).toContain(
      'cursor: pointer',
    );
  });

  it('offers the caret on a mark nothing answers', () => {
    // A settled thread keeps its mark with the paint taken off it, so those
    // words read as prose and a press does nothing. Offered unconditionally,
    // the pointer made them read as a link mid-sentence (user 2026-09-22).
    //
    // Read by state rather than off the unconditional rule: what these words
    // get is decided by every rule that matches them, so a case asking only
    // whether one of those rules stays silent passes while another one hands
    // them the pointer.
    expect(ruleBody(`${MARK}[data-orphan='true']`)).toContain('cursor: auto');
  });

  it('says nothing about the caret without asking which mark this is', () => {
    // The two rules above are the whole of it: one answers presses, one does
    // not, and each says what its words get. A third answer written into the
    // rule they share would reach both.
    expect(ruleBody(MARK)).not.toContain('cursor');
  });

  it('goes unpainted once its thread is resolved or gone', () => {
    // The mark stays: it is where the highlight comes back from when the
    // thread is reopened. Only the paint goes.
    expect(ruleBody(`${MARK}[data-orphan='true']`)).toContain(
      'background-color: transparent',
    );
  });

  it('deepens while its thread is the one being read', () => {
    // The decoration lands outside the marks rather than on them — so the
    // deeper colour has to reach both the decoration and whatever marks sit
    // inside it. Read as a family, because how many selectors that takes is
    // not the point.
    const painted = declarationsOf(READING_CLASS, 'background-color');

    expect(painted.length).toBeGreaterThan(0);
    painted.forEach((declaration) => {
      expect(declaration.value).toBe('var(--color-comment-mark-active)');
    });
  });

  it('takes the colour off the library own decoration', () => {
    // Writing `selectedThreadId` into the library's store is what makes its
    // click handler stand aside (A20), and it also makes the library draw a
    // decoration of its own over the MERGED range — first start to last end,
    // which covers any gap between two runs of one thread. The library
    // colours that decoration through a descendant selector on the mark, so
    // a gap carrying a mark of its own is painted as though it belonged to
    // the thread being read; a settled comment's words dragged between two
    // runs of a live one measured rgba(255, 200, 0, 0.25) that way.
    const painted = declarationsOf(
      'bn-thread-mark-selected',
      'background-color',
    );

    expect(painted.length).toBeGreaterThan(0);
    painted.forEach((declaration) => {
      expect(declaration.value).toBe('transparent');
    });
  });
});
