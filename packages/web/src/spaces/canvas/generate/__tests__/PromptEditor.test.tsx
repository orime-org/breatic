// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';

import { PromptEditor } from '@web/spaces/canvas/generate/PromptEditor';

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
});
