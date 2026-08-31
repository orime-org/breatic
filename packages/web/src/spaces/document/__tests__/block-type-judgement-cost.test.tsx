// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The greying judgement is asked once, when the menu opens (§6.7).
 *
 * It builds the nine transactions the presses would build, which is what makes
 * it trustworthy and what makes it cost with the square of the selection: over
 * a select-all one pass measures 42ms at 200 list items, 303ms at 600 and 764ms
 * at 1000. Every transaction the editor sees would re-run an editor selector,
 * and a co-editor typing into a long document is a stream of them — with the
 * menu shut that freezes the document over rows nobody is looking at, and with
 * it open it charges the whole pass to each of their keystrokes.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';

import { canRunBlockType } from '@web/spaces/document/document-block-press';

import {
  mountDocumentEditor,
  hoverOpenSlot,
  openSharedBody,
  closeShared,
} from './bubble-bar-harness';
import { selectWholeBody } from './block-type-fixtures';

vi.mock('@web/spaces/document/document-block-press', async (importOriginal) => {
  const real = await importOriginal<
    typeof import('@web/spaces/document/document-block-press')
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

  it('is not asked again while the menu stays down', async () => {
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
    await hoverOpenSlot(SLOT);

    // The menu stays down while a co-editor types, and each of their keystrokes
    // arrives as a transaction. The reader's own press re-reads the state it is
    // given, so what it does never rests on an answer from earlier.
    asked.mockClear();
    act(() => {
      editor.view.dispatch(editor.state.tr.setMeta('probe', true));
      editor.view.dispatch(editor.state.tr.setMeta('probe', true));
    });
    expect(asked, 'asked again for a transaction nobody pressed').not.toHaveBeenCalled();
  });
});
