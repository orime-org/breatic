// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The prompt editor on a dialogue's side (inner#1825 design 8.5): one
 * paragraph per line, each carrying the `speaker` it is said by, kept true by
 * the editor itself whatever brought the text in: an old node written as
 * `Name: line`, a pasted script, a collaborator's write.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { yUndoPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import { PromptEditor, type PromptEditorHandle } from '@web/spaces/canvas/generate/PromptEditor';

/** The slice of a TipTap editor these cases drive. */
interface LiveEditor {
  view: {
    state: unknown;
    pasteText: (text: string) => boolean;
  };
  state: { doc: { descendants: (f: (node: { type: { name: string }; attrs: Record<string, unknown>; textContent: string }) => boolean | void) => void } };
  commands: { insertContentAt: (at: number, text: string) => boolean; undo: () => boolean };
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
