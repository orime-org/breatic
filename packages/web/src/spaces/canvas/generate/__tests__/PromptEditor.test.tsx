// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

/** Reads the empty paragraph's data-placeholder (what the Placeholder ext renders). */
function currentPlaceholder(): string | null {
  return document
    .querySelector('.ProseMirror p')
    ?.getAttribute('data-placeholder') ?? null;
}

describe('PromptEditor — collaborative plain-text prompt (slice 1)', () => {
  it('mounts an editor bound to the given prompt fragment and reports its text', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const onTextChange = vi.fn();
    const onAtMentionsChange = vi.fn();

    render(
      <PromptEditor
        fragment={fragment}
        placeholder='Describe the image'
        onTextChange={onTextChange}
        onAtMentionsChange={onAtMentionsChange}
        references={[]}
        mode='t2i'
        mentionEmptyLabel='No references'
      />,
    );

    // The editor container renders; the editor mounts asynchronously
    // (immediatelyRender: false), after which onTextChange fires from onCreate.
    expect(screen.getByTestId('generate-prompt-editor')).toBeInTheDocument();
    await waitFor(() => expect(onTextChange).toHaveBeenCalled());
    // The `@`-mention reporter fires alongside the text; an empty prompt picks
    // nothing, so it reports an empty source-id list.
    expect(onAtMentionsChange).toHaveBeenCalledWith([]);
  });

  it('re-syncs the placeholder when it changes mid-panel (in-session locale switch)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const props = {
      fragment,
      onTextChange: vi.fn(),
      onAtMentionsChange: vi.fn(),
      references: [],
      mode: 't2i' as const,
      mentionEmptyLabel: 'No references',
    };

    const { rerender } = render(
      <PromptEditor {...props} placeholder='Describe the image' />,
    );
    await waitFor(() =>
      expect(currentPlaceholder()).toBe('Describe the image'),
    );

    // A locale switch re-renders PromptEditor with the new-language string but
    // does NOT change the fragment. The editor must re-sync (not stay stuck on
    // the old language until the panel is reopened) — adversarial round-2.
    rerender(<PromptEditor {...props} placeholder='画像を説明' />);
    await waitFor(() => expect(currentPlaceholder()).toBe('画像を説明'));
  });

  // t2i grey-out scope (round-2 adversarial): the dim pre-announces "this
  // reference will not take effect in t2i" — TRUE for image chips (execute
  // forces referenceUrls=[] in t2i) but FALSE for text chips (their
  // substitution still feeds the prompt string and the submitted payload).
  // The dim selector must therefore target image chips only.
  it('t2i dims only IMAGE chips (text substitutions still take effect)', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    render(
      <PromptEditor
        fragment={fragment}
        placeholder='Describe'
        onTextChange={vi.fn()}
        onAtMentionsChange={vi.fn()}
        references={[]}
        mode='t2i'
        mentionEmptyLabel='No references'
      />,
    );
    const cls = screen.getByTestId('generate-prompt-editor').className;
    expect(cls).toContain('[data-kind=image]');
    expect(cls).not.toMatch(/\[&_\.reference-mention\]:opacity/);
  });

  // Execute-gate mirror freshness (round-2 adversarial): a text chip's
  // substitution reads the SOURCE NODE's content, which can change without any
  // prompt-document edit (the user types into the text node on the canvas).
  // The reported prompt text must re-sync when the pool changes, or the
  // execute button stays stuck on the stale substitution (empty node @-ed →
  // button dead forever; emptied node → button lit but execute silently
  // no-ops).
  it('re-reports the substituted prompt text when a referenced text node content changes', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const onTextChange = vi.fn();
    const textRef = (content: string): ReferenceRailItem => ({
      refId: 'txt->me',
      sourceNodeId: 'txt',
      sourceNodeType: 'text',
      sourceNodeName: 'Notes',
      textContent: content,
    });
    const ref = React.createRef<PromptEditorHandle>();
    const props = {
      fragment,
      placeholder: 'Describe',
      onTextChange,
      onAtMentionsChange: vi.fn(),
      mode: 'i2i' as const,
      mentionEmptyLabel: 'No references',
    };
    const { rerender } = render(
      <PromptEditor {...props} ref={ref} references={[textRef('')]} />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current?.insertReference(textRef(''));
    });
    // The empty text node substitutes to '' — reported text is empty.
    await waitFor(() =>
      expect(onTextChange).toHaveBeenLastCalledWith(''),
    );
    // The user types into the text node ON THE CANVAS: the prompt document
    // never changes, only the pool row's textContent does.
    rerender(
      <PromptEditor {...props} ref={ref} references={[textRef('a red fox')]} />,
    );
    await waitFor(() =>
      expect(onTextChange).toHaveBeenLastCalledWith('a red fox'),
    );
  });
});
