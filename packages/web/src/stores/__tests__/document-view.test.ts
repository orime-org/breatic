// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1149 A11: whether the heading outline is shown is one value for every
 * open document, remembered for each account in this browser.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { readUserPreferences, writeUserPreference } from '@web/lib/user-preferences-storage';
import { useDocumentViewStore } from '@web/stores/document-view';

const ALICE = 'user-alice';
const BOB = 'user-bob';

describe('useDocumentViewStore — the outline shown or hidden, per account', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useDocumentViewStore.setState(useDocumentViewStore.getInitialState());
  });

  it('shows the outline for an account that stored nothing', () => {
    useDocumentViewStore.setState({ outlineVisible: false });
    useDocumentViewStore.getState().restore(ALICE);
    expect(useDocumentViewStore.getState().outlineVisible).toBe(true);
  });

  it('restores what each account stored, and two accounts in one browser stay apart', () => {
    writeUserPreference(ALICE, { documentOutlineVisible: false });

    useDocumentViewStore.getState().restore(ALICE);
    expect(useDocumentViewStore.getState().outlineVisible).toBe(false);

    useDocumentViewStore.getState().restore(BOB);
    expect(useDocumentViewStore.getState().outlineVisible).toBe(true);
  });

  it('writes a change to the restored account only', () => {
    useDocumentViewStore.getState().restore(ALICE);

    useDocumentViewStore.getState().toggleOutline();
    expect(useDocumentViewStore.getState().outlineVisible).toBe(false);
    expect(readUserPreferences(ALICE).documentOutlineVisible).toBe(false);
    expect(readUserPreferences(BOB).documentOutlineVisible).toBe(true);

    useDocumentViewStore.getState().toggleOutline();
    expect(readUserPreferences(ALICE).documentOutlineVisible).toBe(true);
  });

  it('writes nothing before an account is restored', () => {
    useDocumentViewStore.getState().toggleOutline();
    expect(window.localStorage.length).toBe(0);
  });

  it('still opens and shuts for this session when storage refuses the write', () => {
    useDocumentViewStore.getState().restore(ALICE);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });

    useDocumentViewStore.getState().toggleOutline();
    expect(useDocumentViewStore.getState().outlineVisible).toBe(false);
    useDocumentViewStore.getState().toggleOutline();
    expect(useDocumentViewStore.getState().outlineVisible).toBe(true);
  });

  it('shows the outline when storage cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    useDocumentViewStore.setState({ outlineVisible: false });

    useDocumentViewStore.getState().restore(ALICE);
    expect(useDocumentViewStore.getState().outlineVisible).toBe(true);
  });
});
