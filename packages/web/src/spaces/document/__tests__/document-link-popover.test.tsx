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

/**
 * Open `ONE_LINK`'s link in the view state, then press edit.
 * @param editor - The editor.
 */
async function enterEditState(editor: Editor): Promise<void> {
  await openPopoverOver(editor, 4, 12);
  fireEvent.click(screen.getByTestId('doc-link-edit'));
  await waitFor(() => {
    expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
  });
}

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

  it('opens the view state for a selection that merely overlaps the link', async () => {
    // 2 to 14 covers part of the link and text either side of it. This is the
    // one shape where the two readers can disagree: `editor.isActive('link')`
    // answers false here, because it asks the mark to cover the whole
    // selection, while the probe this control uses answers true. Without a
    // case on it, either reader could be swapped for a different criterion and
    // nothing would go red — the button would light while the panel opened
    // with no way to remove the link the button says is there. The button's
    // own reading of this same span is pinned by the first case in this file,
    // which asks it before the panel opens; by this point the bar is gone.
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 2, 14);

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    expect(screen.getByTestId('doc-link-remove')).toBeInTheDocument();
  });

  it('selects the whole link when one in the body is clicked', async () => {
    // The mouse route into `view`, and the only reason this slice changed
    // `openOnClick` and `enableClickSelection`. The extension's handler asks
    // whether the event's target is an anchor element (`extension-link`
    // dist:138) and needs no coordinates, so a real click reaches it here.
    const editor = mount(ONE_LINK);
    act(() => {
      editor.view.dom.focus();
      editor.commands.setTextSelection(5);
    });
    const anchor = editor.view.dom.querySelector('a');
    expect(anchor).not.toBeNull();

    fireEvent.mouseDown(anchor!);
    fireEvent.mouseUp(anchor!);
    fireEvent.click(anchor!);

    // The whole link, not the caret the click placed.
    await waitFor(() => {
      expect({
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      }).toEqual({ from: 4, to: 12 });
    });
  });

  it('stays shut when a link in the body is clicked', async () => {
    // Selecting the link brings the bar up with its button pressed. Opening
    // the panel is a second, deliberate act; a click that only selects must
    // not perform it.
    const editor = mount(ONE_LINK);
    act(() => {
      editor.view.dom.focus();
      editor.commands.setTextSelection({ from: 4, to: 12 });
    });

    await waitFor(() => {
      expect(screen.getByTestId('doc-bubble-tool-link')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
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

  it('re-reads the confirm button as the address is retyped', async () => {
    const editor = mount(ONE_LINK);
    await enterEditState(editor);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'hello world' },
    });
    expect(screen.getByTestId('doc-link-confirm')).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'https://c.example' },
    });
    expect(screen.getByTestId('doc-link-confirm')).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it('says why a replacement address is refused, and keeps the old one', async () => {
    const editor = mount(ONE_LINK);
    await enterEditState(editor);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'hello world' },
    });
    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    // Still in the edit state, saying why — and the link in the document is
    // the one it started with.
    expect(screen.getByTestId('doc-link-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    expect(editor.getHTML()).toContain(HREF);
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
    // reaching for the text again is hundreds of milliseconds away; without
    // this wait both actions land in one tick, and that frame's focus arrives
    // at the freshly opened panel, which Radix reads as focus leaving.
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
    });

    // Closing dropped the selection, so reaching the button again means
    // selecting again — the same route a person takes.
    await openPopoverOver(editor, 1, 6);
    expect(screen.getByTestId('doc-link-input')).toHaveValue('');
  });

  it('closes on a press in the body, which is also what moves the selection', async () => {
    // A press in the body is one action with two endings in the transition
    // table — the local selection moves, and the panel is dismissed — and both
    // arrive at the same place. Which of Radix's outside signals fires first is
    // not asserted: deleting the panel's outside-press handling leaves this
    // green, so the mechanism named here would be a guess.
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    await userEvent.click(editor.view.dom);

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
  });

  it('leaves focus where the user put it when they closed it by clicking elsewhere', async () => {
    // Closing hands the caret back to the body, which is right for Escape and
    // for a second press on the button: nothing else has taken focus, and
    // Radix's own default would return it to the trigger, which here is a
    // zero-size aria-hidden span. It is wrong when the user has just clicked
    // into something else — the agent chat sits beside the editor — because
    // their next keystrokes would land in the shared document and reach every
    // peer.
    const editor = mount('<p>plain text here</p>');
    render(<input data-testid='elsewhere' />);
    await openPopoverOver(editor, 1, 6);

    await userEvent.click(screen.getByTestId('elsewhere'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(screen.getByTestId('elsewhere'));
    expect(editor.view.hasFocus()).toBe(false);
  });

  it('hands the caret back to the body on Escape', async () => {
    const editor = mount('<p>plain text here</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.keyDown(screen.getByTestId('doc-link-popover'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
    });

    expect(editor.view.hasFocus()).toBe(true);
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

describe('the panel\'s container', () => {
  it('lives in the body scroller, and in neither the bar nor the editor', async () => {
    // In the scroller so that it travels with the text it points at, and so
    // that the scroller's overflow clips it once that text scrolls away.
    //
    // The editor's own DOM is torn down when a Space tab changes, and the bar
    // steps out of sight the moment the panel opens. The panel is inside
    // neither.
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    const panel = screen.getByTestId('doc-link-popover');
    const scroller = editor.view.dom.closest('[data-radix-scroll-area-viewport]');

    expect(scroller).not.toBeNull();
    expect(scroller?.contains(panel)).toBe(true);
    expect(editor.view.dom.contains(panel)).toBe(false);
    expect(screen.getByTestId('doc-selection-bubble-bar').contains(panel)).toBe(false);
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

  it('closes the edit state, draft and all, when the peer deletes the link', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 2, 14);
    fireEvent.click(screen.getByTestId('doc-link-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'https://typed-but-never-sent.example' },
    });

    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).delete(3, 8);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    // The draft went with it: the text that carried the link is gone, so the
    // next open is a `create` over plain text, and it opens empty. The frame
    // in between is the same one the Escape case waits out — closing hands
    // focus back to the body a frame later, and without the wait that frame
    // lands on the newly opened panel, which Radix reads as focus leaving.
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(null));
      });
    });
    await openPopoverOver(editor, 1, 4);
    expect(screen.getByTestId('doc-link-input')).toHaveValue('');
  });

  it('keeps the edit state and its draft when the peer types ahead of the link', async () => {
    const editor = mount(ONE_LINK);
    await enterEditState(editor);
    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'https://half-typed.example' },
    });

    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).insert(0, 'XX');
    });

    // The panel stays put and the half-typed address survives: following the
    // document re-reads where the link now is, it does not re-seed the field.
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toHaveValue(
        'https://half-typed.example',
      );
    });
    // And confirming now still lands on the link, which has moved two
    // characters along.
    fireEvent.click(screen.getByTestId('doc-link-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).toContain('https://half-typed.example');
    expect(editor.getHTML()).toContain('XXsee');
  });

  it('writes to the link it opened on when the peer makes another one first', async () => {
    // Two links inside one selection, and the panel acts on the one the user
    // opened it over. Answering "which link does this selection hold" a second
    // time cannot tell them apart: it takes the earliest in document order,
    // which is now the peer's.
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 2, 14);
    fireEvent.click(screen.getByTestId('doc-link-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'https://mine.example' },
    });

    // The peer links one character of `see`, inside the selection and earlier
    // in the document than the link this panel opened on.
    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).format(1, 1, {
        link: { href: 'https://peer.example' },
      });
    });
    // Wait on the peer's link reaching this document rather than on a clock:
    // what follows only means anything once it has.
    await waitFor(() => {
      expect(editor.getHTML()).toContain('peer.example');
    });

    fireEvent.click(screen.getByTestId('doc-link-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });

    const html = editor.getHTML();
    expect(html).toContain('href="https://mine.example">our docs<');
    expect(html).toContain('href="https://peer.example"');
    expect(html).not.toContain(HREF);
  });

  it('closes when the peer deletes the link it opened on, second link or not', async () => {
    // The close test has to be about the link the panel holds. "Does the
    // selection hold any link" answers yes here — the peer's is still there —
    // and the panel would silently point at a link the user never opened.
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 2, 14);
    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).format(1, 1, {
        link: { href: 'https://peer.example' },
      });
    });
    // Wait on the peer's link reaching this document rather than on a clock:
    // what follows only means anything once it has.
    await waitFor(() => {
      expect(editor.getHTML()).toContain('peer.example');
    });
    expect(screen.getByTestId('doc-link-popover')).toBeInTheDocument();

    // Now the link the panel opened on goes; the peer's remains.
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

  it('writes no link when the peer deletes the text this panel had selected', async () => {
    // The selection collapses to a point, and an empty selection is one the
    // bubble bar does not show itself for — so the bar goes, and the panel
    // rendered inside it goes with it. Measured: neither is in the document
    // afterwards. The user never reaches confirm, and nothing hangs a link on
    // an empty range.
    const editor = mount('<p>abcdefghij</p>');
    await openPopoverOver(editor, 1, 11);

    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).delete(0, 10);
    });
    await waitFor(() => {
      expect(editor.state.doc.textContent).toBe('');
    });

    expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    expect(screen.queryByTestId('doc-bubble-tool-link')).not.toBeInTheDocument();
    expect(editor.getHTML()).not.toContain('<a');
  });

  it('leaves the panel closed when the peer edits and nothing opened it', async () => {
    // One of the four writers of `mode`: the transaction effect. It may write
    // `closed` and nothing else, and it returns immediately while the panel is
    // already closed. Opening is the link button's alone.
    const editor = mount(ONE_LINK);
    await selectWithFocus(editor, 4, 12);
    expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();

    asPeer((body) => {
      const block = body.get(0) as Y.XmlElement;
      (block.get(0) as Y.XmlText).insert(0, 'XX');
    });
    await waitFor(() => {
      expect(editor.getHTML()).toContain('XXsee');
    });

    expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
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
    expect(screen.getByTestId('doc-bubble-tool-link')).toBeInTheDocument();

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

describe('what the bar carries and what happens around the panel', () => {
  it('puts the bar out of sight while the panel is open', async () => {
    // Out of sight rather than out of the document: the panel is rendered by a
    // component the bar owns, so a bar that leaves takes the panel with it.
    // Measured in a browser — telling the plugin to hide left bar, button and
    // panel all absent. Whether these classes really make it invisible is a
    // question for the browser too; jsdom loads no stylesheet.
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    const bar = screen.getByTestId('doc-selection-bubble-bar');
    expect(bar.className).toContain('invisible!');
    expect(bar.className).toContain('pointer-events-none');
  });

  it('drops the selection when the panel closes, so the bar stays away', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.state.selection.empty).toBe(true);
    // Which is what keeps it away: the bar shows on a selection, and there is
    // none left for it to show on.
    expect(
      screen.queryByTestId('doc-selection-bubble-bar'),
    ).not.toBeInTheDocument();
  });
});

describe('text that cannot carry a link', () => {
  it('offers the button dead over inline code', async () => {
    // `Code`'s mark spec excludes every other mark, so `setLink` over it is a
    // write that leaves the document untouched. Measured before this case
    // existed: typing an address and confirming produced identical `getHTML`
    // either side — a press that says it worked and did nothing.
    const editor = mount('<p>run <code>npm ci</code> first</p>');
    await selectWithFocus(editor, 5, 11);

    expect(screen.getByTestId('doc-bubble-tool-link')).toBeDisabled();
  });

  it('offers it dead for a selection that only partly holds code', async () => {
    // Half of such a write would land and half would not, which is worse than
    // neither: the user would see one of the two words they selected turn into
    // a link.
    const editor = mount('<p>run <code>npm ci</code> first</p>');
    await selectWithFocus(editor, 1, 11);

    expect(screen.getByTestId('doc-bubble-tool-link')).toBeDisabled();
  });

  it('offers it dead inside a code block', async () => {
    // A different refusal from inline code: `codeBlock`'s content spec allows
    // no marks at all, so a question about the `code` mark answers "no code
    // here". Measured before the guard asked the right question: `setLink` over
    // this selection returned byte-identical HTML.
    const editor = mount('<pre><code>npm install</code></pre>');
    await selectWithFocus(editor, 1, 12);

    expect(screen.getByTestId('doc-bubble-tool-link')).toBeDisabled();
  });

  it('offers it dead for a selection running from prose into a code block', async () => {
    const editor = mount('<p>see this</p><pre><code>npm i x</code></pre>');
    await selectWithFocus(editor, 1, 18);

    expect(screen.getByTestId('doc-bubble-tool-link')).toBeDisabled();
  });

  it('leaves it live over ordinary text beside code', async () => {
    const editor = mount('<p>run <code>npm ci</code> first</p>');
    await selectWithFocus(editor, 12, 17);

    expect(screen.getByTestId('doc-bubble-tool-link')).toBeEnabled();
  });
});
