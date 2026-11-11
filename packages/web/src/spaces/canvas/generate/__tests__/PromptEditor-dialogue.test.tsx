// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The prompt editor on a dialogue's side (inner#1825 design 8.5): one
 * paragraph per line, each carrying the `speaker` it is said by, kept true by
 * the editor itself whatever brought the text in: an old node written as
 * `Name: line`, a pasted script, a collaborator's write.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import * as Y from 'yjs';

import en from '@locales/en.json';
import { t } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { yUndoPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import { PromptEditor, type PromptEditorHandle } from '@web/spaces/canvas/generate/PromptEditor';

/** The slice of a TipTap editor these cases drive. */
interface LiveEditor {
  view: {
    state: unknown;
    pasteText: (text: string) => boolean;
    someProp: (name: 'handleKeyDown', f: (handler: (view: unknown, event: KeyboardEvent) => boolean) => boolean | undefined) => boolean | undefined;
  };
  state: { doc: { descendants: (f: (node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }, pos: number) => boolean | void) => void } };
  commands: { insertContentAt: (at: number, text: string) => boolean; undo: () => boolean; setTextSelection: (at: number) => boolean };
}

/**
 * Mounts the prompt editor on a fragment.
 * @param fragment - The node's tts prompt.
 * @param names - The configured speakers' names on the dialogue side; absent on the single side.
 * @returns The live editor once it has mounted.
 */
async function mount(fragment: Y.XmlFragment, names?: readonly string[]): Promise<LiveEditor> {
  render(
    <PromptEditor
      fragment={fragment}
      placeholder='Write'
      onTextChange={vi.fn()}
      onAtMentionsChange={vi.fn()}
      references={[]}
      referenceKinds={[]}
      mentionEmptyLabel='No references'
      {...(names === undefined ? {} : { dialogue: { names } })}
    />,
    { wrapper: TooltipProvider },
  );
  let editor: LiveEditor | undefined;
  await waitFor(() => {
    editor = (screen.getByTestId('generate-prompt-editor').querySelector('.ProseMirror') as unknown as { editor?: LiveEditor } | null)?.editor;
    expect(editor).toBeDefined();
  });
  return editor as LiveEditor;
}

/**
 * Each paragraph the editor holds, as speaker and words.
 * @param editor - The live editor.
 * @returns One entry per paragraph.
 */
function linesOf(editor: LiveEditor): Array<{ speaker: unknown; text: string }> {
  const lines: Array<{ speaker: unknown; text: string }> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'paragraph') return;
    lines.push({ speaker: node.attrs.speaker ?? null, text: node.textContent });
    return false;
  });
  return lines;
}

/**
 * Each paragraph of a fragment, as speaker and words.
 * @param fragment - The stored prompt.
 * @returns One entry per paragraph.
 */
function storedLines(fragment: Y.XmlFragment): Array<{ speaker: unknown; text: string }> {
  return fragment
    .toArray()
    .filter((block): block is Y.XmlElement => block instanceof Y.XmlElement && block.nodeName === 'paragraph')
    .map((block) => {
      const speaker = block.getAttribute('speaker') as unknown;
      return { speaker: speaker === undefined || speaker === null ? null : Number(speaker), text: block.toArray().map((child) => (child instanceof Y.XmlText ? child.toString() : '')).join('') };
    });
}

/**
 * A prompt as an old node stored it: one paragraph per line, no speakers.
 * @param lines - The lines.
 * @returns The fragment.
 */
function legacyPrompt(lines: readonly string[]): Y.XmlFragment {
  const fragment = new Y.Doc().getXmlFragment('prompt');
  fragment.insert(
    0,
    lines.map((line) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(line)]);
      return paragraph;
    }),
  );
  return fragment;
}

const NAMES = ['Ava', 'Leo'];

describe('PromptEditor on the dialogue side', () => {
  it('turns an old `Name：line` prompt into one speaker per line when it opens, with no undo step', async () => {
    const fragment = legacyPrompt(['Ava：x', 'y']);
    const editor = await mount(fragment, NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }, { speaker: 1, text: 'y' }]));
    await waitFor(() => expect(storedLines(fragment)).toEqual([{ speaker: 1, text: 'x' }, { speaker: 1, text: 'y' }]));
    const undo = (yUndoPluginKey.getState(editor.view.state as never) as { undoManager?: Y.UndoManager } | undefined)?.undoManager;
    expect(undo?.undoStack.length ?? 0).toBe(0);
  });

  it('lands a pasted two-line script as two lines, each with its speaker and no name in its words', async () => {
    const editor = await mount(new Y.Doc().getXmlFragment('prompt'), NAMES);
    act(() => {
      editor.view.pasteText('Ava: hi\nLeo: hello');
    });
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'hi' }, { speaker: 2, text: 'hello' }]));
  });

  it('gives a line a collaborator writes with a name prefix that speaker', async () => {
    const fragment = legacyPrompt(['Ava: x']);
    const editor = await mount(fragment, NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }]));
    // A peer's doc writes a second line the way an old client would.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(fragment.doc as Y.Doc));
    const peerFragment = peer.getXmlFragment('prompt');
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('Leo: from afar')]);
    peerFragment.insert(peerFragment.length, [paragraph]);
    act(() => {
      Y.applyUpdate(fragment.doc as Y.Doc, Y.encodeStateAsUpdate(peer));
    });
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }, { speaker: 2, text: 'from afar' }]));
  });

  it('undoes a typed name prefix and the speaker it set in one step', async () => {
    const fragment = legacyPrompt(['Ava: x']);
    const editor = await mount(fragment, NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }]));
    // Inside the first paragraph, before its words.
    act(() => {
      editor.commands.insertContentAt(1, 'Leo: ');
    });
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 2, text: 'x' }]));
    act(() => {
      editor.commands.undo();
    });
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }]));
  });
});

describe('what the dialogue side reports and sends', () => {
  it('reports and serializes the lines written out as `Name: line`, so the gate, the estimate and the run read the same words', async () => {
    const fragment = legacyPrompt(['Ava: x', 'Leo：y', '   ']);
    const onTextChange = vi.fn();
    const ref = React.createRef<PromptEditorHandle>();
    render(
      <PromptEditor
        ref={ref}
        fragment={fragment}
        placeholder='Write'
        onTextChange={onTextChange}
        onAtMentionsChange={vi.fn()}
        references={[]}
        referenceKinds={[]}
        mentionEmptyLabel='No references'
        dialogue={{ names: NAMES }}
      />,
      { wrapper: TooltipProvider },
    );
    await waitFor(() => expect(onTextChange).toHaveBeenLastCalledWith('Ava: x\nLeo: y'));
    expect(ref.current?.serializePrompt()).toBe('Ava: x\nLeo: y');
  });
});

describe('PromptEditor on the single side', () => {
  it('leaves an old `Name：line` prompt as it was written', async () => {
    const fragment = legacyPrompt(['Ava：x', 'y']);
    const editor = await mount(fragment);
    await waitFor(() => expect(linesOf(editor).map((line) => line.text)).toEqual(['Ava：x', 'y']));
    expect(storedLines(fragment)).toEqual([{ speaker: null, text: 'Ava：x' }, { speaker: null, text: 'y' }]);
  });
});

/**
 * Where the first paragraph's words end in the editor's document.
 * @param editor - The live editor.
 * @returns The position.
 */
function endOfFirstLine(editor: LiveEditor): number {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end >= 0) return false;
    if (node.type.name !== 'paragraph') return true;
    end = pos + 1 + node.textContent.length;
    return false;
  });
  return end;
}

/**
 * Presses a key in the editor the way ProseMirror receives it.
 * @param editor - The live editor.
 * @param key - The key.
 */
function press(editor: LiveEditor, key: string): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event));
  });
}

describe('the dialogue lines as the user works them (demo 2026-11-10-1825-dialogue-lines)', () => {
  it('starts each line with a speaker picker showing that speaker\'s name and colour dot', async () => {
    await mount(legacyPrompt(['Ava: x', 'Leo: y']), NAMES);
    await waitFor(() => expect(screen.getAllByTestId('dialogue-line-speaker')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('dialogue-line-speaker');
    expect(first).toHaveTextContent('Ava');
    expect(second).toHaveTextContent('Leo');
    expect(within(first as HTMLElement).getByTestId('dialogue-line-speaker-dot')).toBeInTheDocument();
    expect(within(second as HTMLElement).getByTestId('dialogue-line-speaker-dot')).toBeInTheDocument();
  });

  it('sets the line\'s speaker to the one picked in its picker', async () => {
    const fragment = legacyPrompt(['Ava: x', 'Leo: y']);
    const editor = await mount(fragment, NAMES);
    await waitFor(() => expect(screen.getAllByTestId('dialogue-line-speaker')).toHaveLength(2));
    const user = userEvent.setup();
    await user.click(screen.getAllByTestId('dialogue-line-speaker')[0] as HTMLElement);
    await user.click(await screen.findByTestId('dialogue-line-speaker-option-2'));
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 2, text: 'x' }, { speaker: 2, text: 'y' }]));
    expect(storedLines(fragment)).toEqual([{ speaker: 2, text: 'x' }, { speaker: 2, text: 'y' }]);
  });

  it('starts a new line said by the other speaker on Enter at the end of a line', async () => {
    const editor = await mount(legacyPrompt(['Ava: x']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }]));
    act(() => {
      editor.commands.setTextSelection(endOfFirstLine(editor));
    });
    press(editor, 'Enter');
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }, { speaker: 2, text: '' }]));
  });

  it('adds a line said by the other speaker than the last one with the add line button', async () => {
    const editor = await mount(legacyPrompt(['Ava: x', 'Leo: y']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }, { speaker: 2, text: 'y' }]));
    fireEvent.click(screen.getByTestId('dialogue-add-line'));
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }, { speaker: 2, text: 'y' }, { speaker: 1, text: '' }]));
  });

  it('deletes a line with its ×, and offers no × once one line is left', async () => {
    const editor = await mount(legacyPrompt(['Ava: x', 'Leo: y']), NAMES);
    await waitFor(() => expect(screen.getAllByTestId('dialogue-line-remove')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('dialogue-line-remove')[0] as HTMLElement);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 2, text: 'y' }]));
    expect(screen.queryAllByTestId('dialogue-line-remove')).toHaveLength(0);
  });

  it('draws no speaker picker, add line button or × on the single side', async () => {
    const editor = await mount(legacyPrompt(['Ava: x', 'y']));
    await waitFor(() => expect(linesOf(editor)).toHaveLength(2));
    expect(screen.queryAllByTestId('dialogue-line-speaker')).toHaveLength(0);
    expect(screen.queryByTestId('dialogue-add-line')).toBeNull();
    expect(screen.queryAllByTestId('dialogue-line-remove')).toHaveLength(0);
  });
});

/**
 * The placeholder each line draws while it holds no words.
 * @returns One entry per line: its placeholder, or null when it draws none.
 */
function linePlaceholders(): Array<string | null> {
  return [...screen.getByTestId('generate-prompt-editor').querySelectorAll('.ProseMirror p')].map((p) =>
    p.classList.contains('is-empty') ? p.getAttribute('data-placeholder') : null,
  );
}

describe('an empty dialogue line (demo 2026-11-10-1825-dialogue-lines)', () => {
  it('says whose line it is, and none once it has words', async () => {
    const fragment = legacyPrompt(['Ava: x', 'Leo: ']);
    const editor = await mount(fragment, NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }, { speaker: 2, text: '' }]));
    const leo = t('canvas.generatePanel.dialogueLinePlaceholder', { name: 'Leo' });
    expect(leo).toContain('Leo');
    expect((en.canvas.generatePanel as unknown as Record<string, string | undefined>).dialogueLinePlaceholder).toBeDefined();
    await waitFor(() => expect(linePlaceholders()).toEqual([null, leo]));
  });

  it('follows the line to the speaker picked for it', async () => {
    const editor = await mount(legacyPrompt(['Ava: ', 'Leo: y']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: '' }, { speaker: 2, text: 'y' }]));
    await waitFor(() => expect(linePlaceholders()).toEqual([t('canvas.generatePanel.dialogueLinePlaceholder', { name: 'Ava' }), null]));
    const user = userEvent.setup();
    await user.click(screen.getAllByTestId('dialogue-line-speaker')[0] as HTMLElement);
    await user.click(await screen.findByTestId('dialogue-line-speaker-option-2'));
    await waitFor(() => expect(linePlaceholders()).toEqual([t('canvas.generatePanel.dialogueLinePlaceholder', { name: 'Leo' }), null]));
  });
});

describe('a speaker with no name yet', () => {
  it('reads as its row in the settings, on the picker, in the menu and in the empty line\'s placeholder', async () => {
    const editor = await mount(legacyPrompt(['', 'Leo: y']), ['  ', 'Leo']);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: '' }, { speaker: 2, text: 'y' }]));
    const row = t('canvas.generatePanel.audioSpeakerRow', { n: 1 });
    expect(row).not.toContain('audioSpeakerRow');
    await waitFor(() => expect(screen.getAllByTestId('dialogue-line-speaker')[0]).toHaveTextContent(row));
    await waitFor(() => expect(linePlaceholders()).toEqual([t('canvas.generatePanel.dialogueLinePlaceholder', { name: row }), null]));
    const user = userEvent.setup();
    await user.click(screen.getAllByTestId('dialogue-line-speaker')[0] as HTMLElement);
    expect(await screen.findByTestId('dialogue-line-speaker-option-1')).toHaveTextContent(row);
    expect(screen.getByTestId('dialogue-line-speaker-option-2')).toHaveTextContent('Leo');
  });

  it('is never matched by a line\'s words, so a line starting with a colon keeps them', async () => {
    const editor = await mount(legacyPrompt([': hi']), ['', 'Leo']);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: ': hi' }]));
  });
});

/**
 * Types text into the editor one character at a time, each its own user
 * transaction, the way a keyboard sends it.
 * @param editor - The live editor.
 * @param text - What to type.
 */
function typeKeys(editor: LiveEditor, text: string): void {
  const view = editor.view as unknown as { state: { selection: { from: number; to: number }; tr: { insertText: (t: string, from: number, to: number) => unknown } }; dispatch: (tr: unknown) => void };
  for (const char of text) {
    act(() => {
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.insertText(char, from, to));
    });
  }
}

describe('a name typed in front of a line, key by key', () => {
  it('waits for the words before taking the name and its space off, so the line starts with its words', async () => {
    const editor = await mount(legacyPrompt(['Leo: ']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 2, text: '' }]));
    act(() => {
      editor.commands.setTextSelection(endOfFirstLine(editor));
    });
    typeKeys(editor, 'Ava: Hello');
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'Hello' }]));
  });

  it('does the same after a full-width colon', async () => {
    const editor = await mount(legacyPrompt(['Ava: ']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: '' }]));
    act(() => {
      editor.commands.setTextSelection(endOfFirstLine(editor));
    });
    typeKeys(editor, 'Leo：你好');
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 2, text: '你好' }]));
  });

  it('leaves a line holding only the name and colon as typed', async () => {
    const editor = await mount(legacyPrompt(['Leo: ']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 2, text: '' }]));
    act(() => {
      editor.commands.setTextSelection(endOfFirstLine(editor));
    });
    typeKeys(editor, 'Ava:');
    // Settle past the machine pass a remote change would get.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(linesOf(editor)).toEqual([{ speaker: 2, text: 'Ava:' }]);
  });
});

describe('an input method composing in a line (design 8.5)', () => {
  it('leaves the line alone while composing, and puts it right once the composition ends', async () => {
    const editor = await mount(legacyPrompt(['Ava: ']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: '' }]));
    const view = editor.view as unknown as { input: { composing: boolean }; dom: HTMLElement };
    act(() => {
      editor.commands.setTextSelection(endOfFirstLine(editor));
    });
    view.input.composing = true;
    typeKeys(editor, 'Leo：你');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'Leo：你' }]);
    view.input.composing = false;
    act(() => {
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    });
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 2, text: '你' }]));
  });
});

describe('the Enter an input method sends to accept a candidate (round 3)', () => {
  it('starts no new line, and a plain Enter afterwards still does', async () => {
    const editor = await mount(legacyPrompt(['Ava: x']), NAMES);
    await waitFor(() => expect(linesOf(editor)).toEqual([{ speaker: 1, text: 'x' }]));
    act(() => {
      editor.commands.setTextSelection(endOfFirstLine(editor));
    });
    const view = editor.view as unknown as { dom: HTMLElement };
    /**
     * Sends a keydown of Enter the way ProseMirror receives it.
     * @param keyCode - The key code the browser reports.
     */
    const enter = (keyCode: number): void => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', keyCode, bubbles: true, cancelable: true });
      act(() => {
        editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event));
      });
    };
    // Chrome ends the composition, then sends the key twice: as 229, then as 13.
    act(() => {
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'x' }));
    });
    enter(229);
    enter(13);
    expect(linesOf(editor)).toHaveLength(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    enter(13);
    await waitFor(() => expect(linesOf(editor)).toHaveLength(2));
  });
});
