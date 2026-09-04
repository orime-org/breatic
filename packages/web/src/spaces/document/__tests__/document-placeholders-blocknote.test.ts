// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A14: the "start writing" hint, on the flat model.
 *
 * The hint shows while the document LOOKS empty — nothing a reader could see.
 * That judgement is what the reader sees rather than what the node count says
 * (user 2026-08-18), and the flat model moves two of the things a reader can
 * see out of the node name and into props: a quote is `quoted` on the block
 * rather than a wrapper, and a numbered heading is `numbered`. Both paint
 * something while holding no text — a border, a number — so both keep the hint
 * away, and neither is visible to a check that only reads the node's type.
 *
 * The zero-block half of the old placeholder is gone with the state it drew
 * for. `BlockGroup.ts:11` is `blockGroupChild+`, so a document with no blocks
 * is not a state this editor can rest in, and the backend seeds a fresh Space
 * with one paragraph (§5.4).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, t } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentPlaceholderExtension } from '@web/spaces/document/document-placeholders-blocknote';

const HINT_ATTRIBUTE = 'data-block-placeholder';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding the given blocks.
 * @param blocks - The blocks to write, in BlockNote's own shape.
 * @returns The element the editor rendered into, and the editor itself.
 */
function open(blocks: readonly Record<string, unknown>[]): {
  root: HTMLElement;
  editor: ReturnType<typeof buildDocumentEditor>;
  } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentPlaceholderExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return { root, editor };
}

/**
 * Opens an editor holding the given blocks.
 * @param blocks - The blocks to write.
 * @returns The element the editor rendered into.
 */
function render(blocks: readonly Record<string, unknown>[]): HTMLElement {
  return open(blocks).root;
}

/** The hint text currently painted, or null. */
function hint(root: HTMLElement): string | null {
  return root.querySelector(`[${HINT_ATTRIBUTE}]`)?.getAttribute(HINT_ATTRIBUTE) ?? null;
}

describe('the hint on a document that looks empty', () => {
  it('marks the one empty paragraph a fresh Space is seeded with', () => {
    const root = render([{ type: 'paragraph' }]);
    expect(hint(root)).toBe(t('spaces.document.placeholder'));
  });

  it('marks an empty heading', () => {
    const root = render([{ type: 'heading', props: { level: 2 } }]);
    expect(hint(root)).toBe(t('spaces.document.placeholder'));
  });

  it('marks a paragraph holding nothing but line breaks', () => {
    // A Shift+Enter line paints exactly as much as an empty one, so the hint
    // stays. Pressed rather than constructed, because the point is that an
    // ordinary keystroke reaches this state.
    const { root, editor } = open([{ type: 'paragraph' }]);
    const view = editor.prosemirrorView!;
    view.someProp('handleKeyDown', (handler) =>
      handler(
        view,
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }),
      ),
    );

    expect(view.state.doc.toString()).toContain('hardBreak');
    expect(hint(root)).toBe(t('spaces.document.placeholder'));
  });

  it('stays away once anything is written', () => {
    const root = render([{ type: 'paragraph', content: 'a word' }]);
    expect(hint(root)).toBeNull();
  });

  it('stays away from an empty QUOTED block, which paints its border', () => {
    const root = render([{ type: 'paragraph', props: { quoted: true } }]);
    expect(hint(root)).toBeNull();
  });

  it('stays away from an empty NUMBERED heading, which paints its number', () => {
    const root = render([
      { type: 'heading', props: { level: 1, numbered: true } },
    ]);
    expect(hint(root)).toBeNull();
  });

  it('stays away from an empty list item, which paints its marker', () => {
    const root = render([{ type: 'bulletListItem' }]);
    expect(hint(root)).toBeNull();
  });

  it('stays away when a later block has content', () => {
    const root = render([
      { type: 'paragraph' },
      { type: 'paragraph', content: 'written further down' },
    ]);
    expect(hint(root)).toBeNull();
  });

  it('marks the FIRST block, where typing will land', () => {
    const root = render([{ type: 'paragraph' }, { type: 'paragraph' }]);
    const marked = root.querySelectorAll(`[${HINT_ATTRIBUTE}]`);
    expect(marked).toHaveLength(1);
  });

  it('stays away from an empty CODE block, which paints its own surface', () => {
    expect(hint(render([{ type: 'codeBlock' }]))).toBeNull();
  });

  it('stays away from a fallback block, which paints what it stands in for', () => {
    // Content this build has no vocabulary for is shown rather than hidden, so
    // the page is not empty even when the fallback holds no text of its own.
    expect(hint(render([{ type: 'unsupportedBlock' }]))).toBeNull();
  });

  it('is the only hint on the page — BlockNote draws none of its own', () => {
    // The built-in placeholder decorates blocks that exist and keys off
    // whether the block is focused, so leaving it on would put a second hint
    // beside this one. `build-document-editor` turns it off.
    const root = render([{ type: 'paragraph' }]);
    expect(root.querySelectorAll(`[${HINT_ATTRIBUTE}]`)).toHaveLength(1);
    expect(root.querySelectorAll('[data-is-only-empty-block]')).toHaveLength(0);
    expect(root.querySelectorAll('[data-is-empty-and-focused]')).toHaveLength(0);
  });

  it('marks the block’s content element, the innermost node there is', () => {
    // The flat model puts one more element between the block and its text than
    // the old one did: `blockContent` renders as `div.bn-block-content` and the
    // paragraph lives inside it as `p.bn-inline-content`, which is not a node
    // and so cannot be decorated. Marking the innermost node there IS keeps the
    // hint as close to the text as ProseMirror allows.
    const root = render([{ type: 'paragraph' }]);
    const marked = root.querySelector(`[${HINT_ATTRIBUTE}]`);
    expect(marked?.className).toContain('bn-block-content');
    expect(marked?.querySelector('p')).not.toBeNull();
  });
});
