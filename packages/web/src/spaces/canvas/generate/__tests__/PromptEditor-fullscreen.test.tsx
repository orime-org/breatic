// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A prompt box open full screen (inner#2115): an editor of its own on the same
 * prompt, one editor at a time, the handle following whichever is on screen.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { TextFullscreen } from '@web/spaces/canvas/nodes/_shared/TextFullscreen';
import {
  PromptEditor,
  type PromptEditorHandle,
  type PromptFullscreenLayer,
} from '@web/spaces/canvas/generate/PromptEditor';

/**
 * A prompt with some words in it.
 * @param text - The words.
 * @returns The prompt's fragment.
 */
function promptWith(text: string): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prompt');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
  return fragment;
}

/**
 * The prompt box as a panel renders it.
 * @param props - Component props.
 * @param props.fragment - The prompt.
 * @param props.layer - Its full screen.
 * @param props.handle - Where the handle goes.
 * @returns The box.
 */
function Box({
  fragment,
  layer,
  handle,
}: {
  fragment: Y.XmlFragment;
  layer?: PromptFullscreenLayer;
  handle?: React.Ref<PromptEditorHandle>;
}): React.JSX.Element {
  return (
    <PromptEditor
      ref={handle}
      fragment={fragment}
      placeholder='Write'
      onTextChange={vi.fn()}
      onAtMentionsChange={vi.fn()}
      references={[]}
      referenceKinds={[]}
      mentionEmptyLabel='No references'
      {...(layer === undefined ? {} : { fullscreenLayer: layer })}
    />
  );
}

/**
 * The text of a prompt fragment.
 * @param fragment - The prompt.
 * @returns Its words.
 */
function wordsOf(fragment: Y.XmlFragment): string {
  return fragment.toArray().map((node) => (node as Y.XmlElement).toArray().map((t) => (t as Y.XmlText).toString()).join('')).join('\n');
}

describe('a prompt box open full screen', () => {
  it('shows the box in the panel until it opens', () => {
    render(<Box fragment={promptWith('a dock at night')} layer={{ open: false, title: 'Dock', onClose: vi.fn() }} />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('generate-prompt-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-fullscreen')).toBeNull();
  });

  it('opens with the title, its own editor on the same prompt, and the box saying so', async () => {
    render(<Box fragment={promptWith('a dock at night')} layer={{ open: true, title: 'Dock · Shot 2', onClose: vi.fn() }} />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('prompt-fullscreen-placeholder')).toHaveTextContent('Editing in full screen');
    expect(screen.getByRole('dialog', { name: 'Dock · Shot 2' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('prompt-fullscreen').textContent).toContain('a dock at night'));
    expect(document.querySelectorAll('.ProseMirror')).toHaveLength(1);
  });

  it('draws full screen at the reading size, keeping the box rules for chips', async () => {
    render(<Box fragment={promptWith('x')} layer={{ open: true, title: 'Dock', onClose: vi.fn() }} />, { wrapper: TooltipProvider });
    const editor = await screen.findByTestId('generate-prompt-editor');
    expect(editor).toHaveClass('prompt-editor');
    expect(editor).toHaveClass('text-base');
    expect(editor.className).not.toContain('max-h-40');
  });

  it('hands the handle to the full-screen editor while it is open', async () => {
    const fragment = promptWith('rain');
    const handle = React.createRef<PromptEditorHandle>();
    render(<Box fragment={fragment} handle={handle} layer={{ open: true, title: 'Dock', onClose: vi.fn() }} />, { wrapper: TooltipProvider });
    await screen.findByTestId('generate-prompt-editor');
    handle.current?.insertText('wind');
    await waitFor(() => expect(wordsOf(fragment)).toContain('wind'));
  });

  it('closes on the exit button and comes back to one editor in the panel', async () => {
    const fragment = promptWith('rain');
    const onClose = vi.fn();
    const { rerender } = render(<Box fragment={fragment} layer={{ open: true, title: 'Dock', onClose }} />, { wrapper: TooltipProvider });
    fireEvent.click(screen.getByTestId('prompt-fullscreen-exit'));
    expect(onClose).toHaveBeenCalled();
    rerender(<Box fragment={fragment} layer={{ open: false, title: 'Dock', onClose }} />);
    expect(screen.queryByTestId('prompt-fullscreen')).toBeNull();
    await waitFor(() => expect(document.querySelectorAll('.ProseMirror')).toHaveLength(1));
  });

  it('stays open across a hidden Space, closing only when asked', () => {
    const onClose = vi.fn();
    const fragment = promptWith('rain');
    const layer = { open: true, title: 'Dock', onClose };
    const { rerender } = render(
      <React.Activity mode='visible'><Box fragment={fragment} layer={layer} /></React.Activity>,
      { wrapper: TooltipProvider },
    );
    rerender(<React.Activity mode='hidden'><Box fragment={fragment} layer={layer} /></React.Activity>);
    rerender(<React.Activity mode='visible'><Box fragment={fragment} layer={layer} /></React.Activity>);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('prompt-fullscreen')).toBeInTheDocument();
  });
});

describe('Escape in a full-screen text', () => {
  it('leaves it open when the text claims the key, and closes it otherwise', () => {
    const onClose = vi.fn();
    let claim = true;
    render(
      <TextFullscreen title='Dock' onClose={onClose} onEscapeWithin={() => claim}>
        <p>words</p>
      </TextFullscreen>,
      { wrapper: TooltipProvider },
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    claim = false;
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
