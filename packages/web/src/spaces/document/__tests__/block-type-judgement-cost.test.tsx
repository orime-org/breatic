// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The greying judgement is asked only while the menu is down (§6.7).
 *
 * It builds the eight transactions the presses would build, which is what makes
 * it trustworthy and what makes it cost with the selection: over a select-all
 * one pass measures 1.5ms at 50 blocks, 14ms at 200 and 197ms at 800. The
 * selector holding it runs on every transaction the editor sees — a co-editor
 * typing into a long document is a stream of them — so asking it with the menu
 * shut would freeze the document over nine rows nobody is looking at.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';

import { canRunBlockType } from '@web/spaces/document/document-block-model';

import {
  mountDocumentEditor,
  hoverOpenSlot,
  openSharedBody,
  closeShared,
} from './bubble-bar-harness';
import { selectWholeBody } from './block-type-fixtures';

vi.mock('@web/spaces/document/document-block-model', async (importOriginal) => {
  const real = await importOriginal<
    typeof import('@web/spaces/document/document-block-model')
  >();
  return { ...real, canRunBlockType: vi.fn(real.canRunBlockType) };
});

const asked = vi.mocked(canRunBlockType);

afterEach(() => {
  closeShared();
  vi.restoreAllMocks();
});

const SLOT = 'doc-bubble-block-type';

describe('the greying judgement', () => {
  it('is not asked while the menu is shut, and is once it is down', async () => {
    const editor = openSharedBody('<p>the quick brown fox</p><p>a second line</p>');
    mountDocumentEditor(editor);
    act(() => {
      editor.view.dom.focus();
      selectWholeBody(editor);
    });
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
      ).toBeGreaterThan(0);
    });

    // The bar is up with the menu shut. What the selector answers to is a
    // transaction reaching the editor, whoever sent it and whatever it carried
    // — a co-editor's keystroke arrives as one of these — so one that leaves
    // the selection alone is the case to press on.
    asked.mockClear();
    const seen = vi.fn();
    editor.on('transaction', seen);
    act(() => {
      editor.view.dispatch(editor.state.tr.setMeta('probe', true));
    });
    expect(seen, 'no transaction reached the editor').toHaveBeenCalled();
    expect(asked, 'asked with nobody looking').not.toHaveBeenCalled();

    await hoverOpenSlot(SLOT);
    expect(asked).toHaveBeenCalled();
  });
});
