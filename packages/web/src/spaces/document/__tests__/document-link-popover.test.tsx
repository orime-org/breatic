// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The link panel's four states and the moves between them (task #903).
 *
 * The transition table in §5.3 of the design document is where these cases come
 * from: one fact (which state is showing) takes four values and four paths can
 * write it, so the table exists ahead of the code and this file redeems it cell
 * by cell.
 *
 * The three answers about the document — which link a selection holds, what a
 * write does, what an unqualified string becomes — belong to
 * `document-link.test.ts`, which runs with no React in the picture. This file
 * asks only about the control: which state opens, what it holds, where a press
 * leads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

const editors: Editor[] = [];
let doc: Y.Doc;

const HREF = 'https://a.example/docs';

beforeEach(() => {
  doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
});

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
  doc.destroy();
  vi.restoreAllMocks();
});

/**
 * An editor holding the given body, mounted into the document.
 * @param bodyHtml - The body to load.
 * @returns The editor.
 */
function mount(bodyHtml: string): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  editor.commands.setContent(bodyHtml);
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} readOnly={false} />
    </TooltipProvider>,
  );
  return editor;
}

/**
 * Select a span, give the editor real focus, and wait for the bar.
 *
 * The focus is a hard condition: the plugin's `shouldShow` asks for
 * `view.hasFocus()`, and the bar's element only enters the document inside
 * `show()`.
 * @param editor - The editor.
 * @param from - Where the selection starts.
 * @param to - Where it ends.
 */
async function selectWithFocus(editor: Editor, from: number, to: number): Promise<void> {
  act(() => {
    editor.view.dom.focus();
    editor.commands.setTextSelection({ from, to });
  });
  await waitFor(() => {
    expect(screen.getByTestId('doc-bubble-tool-link')).toBeInTheDocument();
  });
}

/**
 * Select a span, then press the link button.
 * @param editor - The editor.
 * @param from - Where the selection starts.
 * @param to - Where it ends.
 */
async function openPopoverOver(editor: Editor, from: number, to: number): Promise<void> {
  await selectWithFocus(editor, from, to);
  await pressLinkButton();
  await waitFor(() => {
    expect(screen.getByTestId('doc-link-popover')).toBeInTheDocument();
  });
}

/**
 * Press the link button on the bubble bar.
 *
 * Through the whole pointer sequence: the plugin raises `preventHide` in a
 * capture-phase mousedown (`@tiptap/extension-bubble-menu` dist:78-79), and the
 * body loses focus the moment the panel opens — without that press
 * `blurHandler` takes the whole bar out of the document.
 */
async function pressLinkButton(): Promise<void> {
  await userEvent.click(screen.getByTestId('doc-bubble-tool-link'));
}

/** Body `see<a>our docs</a>for more`: the link occupies [4,12). */
const ONE_LINK = `<p>see<a href="${HREF}">our docs</a>for more</p>`;

describe('the link button', () => {
  it('reads as pressed while the selection meets a link', async () => {
    const editor = mount(ONE_LINK);
    await selectWithFocus(editor, 2, 14);

    expect(screen.getByTestId('doc-bubble-tool-link')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('reads as unpressed while the selection merely touches a boundary', async () => {
    const editor = mount(ONE_LINK);
    await selectWithFocus(editor, 12, 20);

    expect(screen.getByTestId('doc-bubble-tool-link')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('which state a press opens', () => {
  it('opens the view state when the selection holds a link', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    expect(screen.getByTestId('doc-link-edit')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-remove')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-link-input')).not.toBeInTheDocument();
  });

  it('makes the address in the view state the thing you open', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    const url = screen.getByTestId('doc-link-url');
    expect(url).toHaveAttribute('href', HREF);
    expect(url).toHaveAttribute('target', '_blank');
    expect(url).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('opens the create state with an empty field and a dimmed confirm', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    expect(screen.getByTestId('doc-link-input')).toHaveValue('');
    // `aria-disabled`, which is the attribute this button carries: a button
    // holding the HTML one is handed no click, and the click is what says why
    // an address is refused.
    expect(screen.getByTestId('doc-link-confirm')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByTestId('doc-link-remove')).not.toBeInTheDocument();
  });
});

describe('making a link', () => {
  it('lights the confirm button once the address is shaped like one', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });

    // Asked as the attribute the button carries. This button never holds the
    // HTML one, so `not.toBeDisabled()` would be green whatever the state.
    expect(screen.getByTestId('doc-link-confirm')).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('dims the confirm button for an address that is not shaped like one', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'hello world' },
    });

    expect(screen.getByTestId('doc-link-confirm')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('says why the address is refused when the dimmed button is pressed', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'hello world' },
    });
    expect(screen.queryByTestId('doc-link-invalid')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    // The red border and the line beneath arrive together, and the document is
    // untouched — the press only states the reason.
    expect(screen.getByTestId('doc-link-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-input')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(editor.getHTML()).not.toContain('<a');
  });

  it('says the same for an empty field', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    expect(screen.getByTestId('doc-link-invalid')).toBeInTheDocument();
    expect(editor.getHTML()).not.toContain('<a');
  });

  it('writes the link and puts the panel away on confirm', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });
    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).toContain('https://example.com');
  });

  it('leaves the document without a link until the press lands', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);
    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });

    expect(editor.getHTML()).not.toContain('<a');
  });
});

describe('changing a link', () => {
  it('enters the edit state seeded with the current address', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    fireEvent.click(screen.getByTestId('doc-link-edit'));

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toHaveValue(HREF);
    });
  });

  it('replaces the address and puts the panel away on confirm', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);
    fireEvent.click(screen.getByTestId('doc-link-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'https://b.example/other' },
    });
    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).toContain('https://b.example/other');
    expect(editor.getHTML()).not.toContain(HREF);
  });
});

describe('removing a link', () => {
  it('takes the link off and puts the panel away', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    fireEvent.click(screen.getByTestId('doc-link-remove'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).not.toContain('<a');
    expect(editor.getHTML()).toContain('our docs');
  });
});

describe('putting the panel away', () => {
  it('drops the draft on Escape, and the next open starts empty', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);
    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });

    fireEvent.keyDown(screen.getByTestId('doc-link-popover'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    // Handing focus back to the body is scheduled a frame out (`@tiptap/core`'s
    // focus command goes through `requestAnimationFrame`, dist:601). A person
    // pressing the button again is hundreds of milliseconds away; without this
    // wait both actions land in one tick, and that frame's focus arrives at the
    // freshly opened panel, which Radix reads as focus leaving and closes it.
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
    });

    await pressLinkButton();
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });
    expect(screen.getByTestId('doc-link-input')).toHaveValue('');
  });

  it('closes all the way from the edit state on Escape', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);
    fireEvent.click(screen.getByTestId('doc-link-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByTestId('doc-link-popover'), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
  });
});

describe('the panel\'s anchor', () => {
  it('lives in the body scroller, and in neither the bar nor the editor', async () => {
    // In the scroller so that it travels with the line it points at: the
    // floating-ui under Radix watches ancestor scroll by default, so the anchor
    // moves itself and the panel comes along.
    //
    // The other two containers both disappear while the panel is still open:
    // the plugin takes the bar away, and ProseMirror tears the editor's DOM
    // down when a Space tab changes. The anchor enters neither.
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    const anchor = screen.getByTestId('doc-link-anchor');
    const scroller = editor.view.dom.closest('[data-radix-scroll-area-viewport]');
    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]');

    expect(scroller).not.toBeNull();
    expect(anchor.parentElement).toBe(scroller);
    expect(editor.view.dom.parentElement?.contains(anchor)).toBe(false);
    expect(bar?.contains(anchor)).toBe(false);
    // The scroller has to be the containing block, or a position computed in
    // its coordinates lands somewhere else. Asked as the class name: jsdom
    // loads no compiled stylesheet, so `getComputedStyle` answers the default
    // for every Tailwind class (measured: this one answers `static`). Whether
    // the positioning is right is measured by smoke.
    expect((scroller as Element).className).toContain('relative');
  });
});

describe('a co-editor changes the body', () => {
  /**
   * Change the document as the peer would.
   *
   * Under an origin other than `ySyncPluginKey`, which is how the sync plugin
   * tells that an update did not come from here — the same route a remote
   * update takes, and the same thing the repo's other collaboration tests do.
   * @param change - The change to make.
   */
  function asPeer(change: (body: Y.XmlFragment) => void): void {
    act(() => {
      doc.transact(() => {
        change(documentBodyFragment(doc));
      }, 'remote-peer');
    });
  }

  it('closes the panel when the peer deletes the link', async () => {
    const editor = mount(ONE_LINK);
    // A selection wider than the link: with the link gone a non-empty stretch
    // of it remains, so the bar stays on screen and the panel's disappearance
    // can only come from the judgement that the link has gone.
    await openPopoverOver(editor, 2, 14);

    // Only the link's own text goes; the paragraph and the words either side
    // stay. A paragraph is one `XmlText` in Yjs and a link is an attribute over
    // a stretch of it, so this deletes by character offset: `see` occupies 0 to
    // 3, `our docs` 3 to 11.
    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).delete(3, 8);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
  });

  it('keeps the panel open when the peer types ahead of the link', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).insert(0, 'XX');
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    });
  });

  it('writes to the whole selection when the peer links part of it mid-create', async () => {
    // `create` means "the span I selected holds no link", and the span is what
    // it writes to. A link the peer makes inside it changes nothing about the
    // task at hand: still to put the typed address on all ten selected
    // characters.
    const editor = mount('<p>abcdefghij</p>');
    await openPopoverOver(editor, 1, 11);
    expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();

    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      // The middle four characters, `defg`, at offsets 3 through 7.
      (block.get(0) as Y.XmlText).format(3, 4, {
        link: { href: 'https://b.example/theirs' },
      });
    });
    await waitFor(() => {
      expect(editor.getHTML()).toContain('b.example');
    });

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'a.example' },
    });
    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    const linked = [...editor.getHTML().matchAll(/<a[^>]*>([^<]*)<\/a>/g)]
      .map((m) => m[1])
      .join('');
    expect(linked).toBe('abcdefghij');
  });

  it('still unlinks the same link after the peer types ahead of it', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).insert(0, 'XX');
    });
    await waitFor(() => {
      expect(editor.getHTML()).toContain('XXsee');
    });

    fireEvent.click(screen.getByTestId('doc-link-remove'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).not.toContain('<a');
    expect(editor.getHTML()).toContain('our docs');
  });
});

describe('when the editor is torn down', () => {
  it('unmounts this tree without throwing after the body container goes', async () => {
    const editor = mount(ONE_LINK);
    await selectWithFocus(editor, 4, 12);
    expect(screen.getByTestId('doc-link-anchor')).toBeInTheDocument();

    // This is the order a Space tab change produces: the editor's DOM is torn
    // down first, React unmounts this tree after. An anchor living inside that
    // DOM would have React remove itself from a node that is no longer its
    // parent, and both jsdom and the browsers throw
    // `NotFoundError: Failed to execute 'removeChild' on 'Node'`.
    act(() => {
      editor.view.dom.parentElement?.remove();
    });

    expect(() => {
      act(() => {
        cleanup();
      });
    }).not.toThrow();
  });
});

describe('after the bubble bar is taken away', () => {
  it('keeps the panel and its anchor', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);
    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]');
    expect(bar).toBeInTheDocument();

    // The plugin does exactly this on any transaction while the panel is open:
    // `shouldShow` asks for the body to hold focus, focus is in the panel, and
    // `hide()` takes the whole bar out of the document.
    act(() => {
      bar?.remove();
    });

    expect(screen.getByTestId('doc-link-popover')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-anchor')).toBeInTheDocument();
  });
});
