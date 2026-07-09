// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';

import { PromptEditor } from '@web/spaces/canvas/generate/PromptEditor';

describe('PromptEditor — collaborative plain-text prompt (slice 1)', () => {
  it('mounts an editor bound to the given prompt fragment and reports its text', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    const onTextChange = vi.fn();

    render(
      <PromptEditor
        fragment={fragment}
        placeholder='Describe the image'
        onTextChange={onTextChange}
      />,
    );

    // The editor container renders; the editor mounts asynchronously
    // (immediatelyRender: false), after which onTextChange fires from onCreate.
    expect(screen.getByTestId('generate-prompt-editor')).toBeInTheDocument();
    await waitFor(() => expect(onTextChange).toHaveBeenCalled());
  });
});
