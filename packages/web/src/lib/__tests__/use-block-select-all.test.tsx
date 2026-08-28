// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useBlockSelectAll } from '@web/lib/use-block-select-all';

interface Fixture {
  plain: HTMLElement;
  input: HTMLInputElement;
  textarea: HTMLTextAreaElement;
  editable: HTMLElement;
  overlayButton: HTMLElement;
}

/**
 * Builds one of each kind of target the gate has to tell apart.
 * @returns The elements a test presses a key on.
 */
function buildPage(): Fixture {
  const plain = document.createElement('div');
  const input = document.createElement('input');
  const textarea = document.createElement('textarea');
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  Object.defineProperty(editable, 'isContentEditable', { value: true });

  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  const overlayButton = document.createElement('button');
  overlay.append(overlayButton);

  document.body.append(plain, input, textarea, editable, overlay);
  return { plain, input, textarea, editable, overlayButton };
}

interface KeyOptions {
  key?: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  repeat?: boolean;
  code?: string;
}

/**
 * Dispatches a keydown from `el` and reports whether the gate blocked it.
 * @param el - Where the key press starts.
 * @param options - Which key, with which modifiers.
 * @returns True when something called preventDefault on it.
 */
function press(el: Element, options: KeyOptions = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key: options.key ?? 'a',
    metaKey: options.meta ?? true,
    ctrlKey: options.ctrl ?? false,
    shiftKey: options.shift ?? false,
    altKey: options.alt ?? false,
    repeat: options.repeat ?? false,
    code: options.code ?? `Key${(options.key ?? 'a').toUpperCase()}`,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('useBlockSelectAll', () => {
  let page: Fixture;

  beforeEach(() => {
    page = buildPage();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe('blocks select-all where a caret cannot land', () => {
    it('on a plain element', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain)).toBe(true);
    });

    // A Russian layout sends 'ф' from the physical A key while the browser
    // still runs select-all off the key's position, so the letter alone
    // misses it.
    it('on a layout whose A key sends another letter', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { key: 'ф', code: 'KeyA' })).toBe(true);
    });

    it('with Ctrl rather than Cmd', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { meta: false, ctrl: true })).toBe(true);
    });

    it('on a capital A, which is what CapsLock sends', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { key: 'A' })).toBe(true);
    });

    it('while the key is held down and repeating', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { repeat: true })).toBe(true);
    });

    it('inside an overlay, which is where the whole page would be selected', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.overlayButton)).toBe(true);
    });

    it('straight from <body>', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(document.body)).toBe(true);
    });
  });

  describe('lets a field select its own content', () => {
    it('an input', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.input)).toBe(false);
    });

    it('a textarea', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.textarea)).toBe(false);
    });

    it('a contenteditable, which is what a document space is', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.editable)).toBe(false);
    });
  });

  // Each of these would be blocked if the gate did not check, so a gate that
  // stopped checking shows up as a changed value rather than hiding behind a
  // case that was going to pass anyway.
  describe('leaves everything else alone', () => {
    it('A without any modifier', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { meta: false })).toBe(false);
    });

    it('Cmd with another letter', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { key: 'c' })).toBe(false);
    });

    it('Cmd+Shift+A, which is a different shortcut', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { shift: true })).toBe(false);
    });

    it('Option+Cmd+A, likewise', () => {
      renderHook(() => useBlockSelectAll());
      expect(press(page.plain, { alt: true })).toBe(false);
    });
  });

  // The document space runs its own two-tier select-all and marks the event
  // handled. Blocking is all this gate does, so the only way to see that it
  // stood down is to count who called preventDefault: the document space
  // once, and nobody after it.
  it('stays out of the way once something else has handled the key', () => {
    renderHook(() => useBlockSelectAll());
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const blocked = vi.spyOn(event, 'preventDefault');
    const handledFirst = (e: Event): void => e.preventDefault();
    page.plain.addEventListener('keydown', handledFirst);
    page.plain.dispatchEvent(event);
    page.plain.removeEventListener('keydown', handledFirst);
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it('stops blocking once unmounted', () => {
    const { unmount } = renderHook(() => useBlockSelectAll());
    unmount();
    expect(press(page.plain)).toBe(false);
  });
});
