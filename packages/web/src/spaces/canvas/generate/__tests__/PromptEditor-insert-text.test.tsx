// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1241 — text inserted from a popover lands where the reader left the
 * caret, although opening the popover took focus away from the editor.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { TooltipProvider } from '@web/components/ui/tooltip';
import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';

/** The slice of the TipTap editor these tests drive the way a reader would. */
interface DrivenEditor {
  commands: {
    insertContent: (s: string) => void;
    setTextSelection: (at: number) => void;
  };
  isFocused: boolean;
}

/**
 * Mounts one editor holding `text`, never focused.
 * @param text - What the prompt says before the insert.
 * @returns The handle, the live editor and the last reported prompt.
 */
async function mount(text: string): Promise<{
  handle: React.RefObject<PromptEditorHandle | null>;
  editor: DrivenEditor;
  reported: () => string;
}> {
  const fragment = new Y.Doc().getXmlFragment('prompt');
  const onTextChange = vi.fn();
  const handle = React.createRef<PromptEditorHandle>();
  render(
    <PromptEditor
      ref={handle}
      fragment={fragment}
      placeholder='Describe'
      onTextChange={onTextChange}
      onAtMentionsChange={vi.fn()}
      references={[]}
      referenceKinds={[]}
      mentionEmptyLabel='No references'
      mentionNoMatchLabel='No matches'
    />,
    { wrapper: TooltipProvider },
  );
  await waitFor(() => expect(handle.current).not.toBeNull());
  await waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull());
  const { editor } = document.querySelector('.ProseMirror') as unknown as { editor: DrivenEditor };
  if (text) act(() => editor.commands.insertContent(text));
  return { handle, editor, reported: () => onTextChange.mock.lastCall?.[0] as string };
}

/**
 * Puts the caret at a position the way a reader's click does. jsdom gives a
 * contenteditable no real focus, so the focus event the click would fire is
 * dispatched on the editor's element, where ProseMirror and TipTap listen.
 * @param editor - The live editor.
 * @param at - The document position.
 */
function placeCaret(editor: DrivenEditor, at: number): void {
  act(() => editor.commands.setTextSelection(at));
  fireEvent.focus(document.querySelector('.ProseMirror') as HTMLElement);
}

describe('PromptEditorHandle.insertText', () => {
  it('appends to the end of a prompt the reader never put a caret in', async () => {
    const { handle, editor, reported } = await mount('a red car');
    // A selection the reader did not make, away from the end: the end still wins.
    act(() => editor.commands.setTextSelection(1));
    act(() => handle.current?.insertText('[Pan left]'));
    await waitFor(() => expect(reported()).toBe('a red car [Pan left]'));
  });

  it('lands at the caret the reader left before focus moved to the popover', async () => {
    const { handle, editor, reported } = await mount('a red car');
    // Position 6 is after "a red" (the paragraph opens at 1).
    placeCaret(editor, 6);
    fireEvent.blur(document.querySelector('.ProseMirror') as HTMLElement);
    expect(editor.isFocused).toBe(false);
    act(() => handle.current?.insertText('[Push in]'));
    await waitFor(() => expect(reported()).toBe('a red [Push in] car'));
  });

  it('lands at the caret while the editor still has focus', async () => {
    const { handle, editor, reported } = await mount('a red car');
    placeCaret(editor, 2);
    act(() => handle.current?.insertText('[Zoom in]'));
    await waitFor(() => expect(reported()).toBe('a [Zoom in] red car'));
  });

  it('keeps a space on both sides when the caret sits inside a word', async () => {
    const { handle, editor, reported } = await mount('a red car');
    // Position 4 is between "r" and "ed".
    placeCaret(editor, 4);
    act(() => handle.current?.insertText('[Tilt up]'));
    await waitFor(() => expect(reported()).toBe('a r [Tilt up] ed car'));
  });

  it('appends again once the editor is rebuilt for another prompt, whatever caret the old one had', async () => {
    const onTextChange = vi.fn();
    const handle = React.createRef<PromptEditorHandle>();
    const element = (fragment: Y.XmlFragment): React.JSX.Element => (
      <PromptEditor
        ref={handle}
        fragment={fragment}
        placeholder='Describe'
        onTextChange={onTextChange}
        onAtMentionsChange={vi.fn()}
        references={[]}
        referenceKinds={[]}
        mentionEmptyLabel='No references'
        mentionNoMatchLabel='No matches'
      />
    );
    const { rerender } = render(element(new Y.Doc().getXmlFragment('prompt')), { wrapper: TooltipProvider });
    await waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull());
    const first = (document.querySelector('.ProseMirror') as unknown as { editor: DrivenEditor }).editor;
    act(() => first.commands.insertContent('old prompt'));
    placeCaret(first, 2);
    rerender(element(new Y.Doc().getXmlFragment('prompt')));
    await waitFor(() =>
      expect((document.querySelector('.ProseMirror') as unknown as { editor: DrivenEditor }).editor).not.toBe(first),
    );
    const second = (document.querySelector('.ProseMirror') as unknown as { editor: DrivenEditor }).editor;
    act(() => second.commands.insertContent('a red car'));
    act(() => second.commands.setTextSelection(1));
    act(() => handle.current?.insertText('[Tilt down]'));
    await waitFor(() => expect(onTextChange.mock.lastCall?.[0]).toBe('a red car [Tilt down]'));
  });

  it('writes the text alone into an empty prompt', async () => {
    const { handle, reported } = await mount('');
    act(() => handle.current?.insertText('[Static shot]'));
    await waitFor(() => expect(reported()).toBe('[Static shot]'));
  });
});
