// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installInputModality } from '@web/lib/input-modality';

type KeyInit = Pick<KeyboardEventInit, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

const modality = (): string | undefined => document.documentElement.dataset.inputModality;

/**
 * Dispatches a keyboard event that bubbles from `target`.
 * @param target - Where the key lands.
 * @param type - `keydown` or `keyup`.
 * @param init - The key and its modifiers.
 */
function press(target: Element, type: 'keydown' | 'keyup', init: KeyInit): void {
  target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/**
 * Dispatches a pointerdown that bubbles from `target`.
 * @param target - Where the pointer lands.
 */
function pointerDown(target: Element): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
}

/**
 * Mounts an element in the document body.
 * @param tag - The tag name.
 * @returns The element.
 */
function mount<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  document.body.append(el);
  return el;
}

/**
 * Builds a contenteditable host with a span inside, the shape a rich-text
 * editor gives its text. jsdom has no `isContentEditable`, so the span gets the
 * value a browser computes for it.
 * @returns The span.
 */
function editableSpan(): HTMLSpanElement {
  const host = mount('div');
  host.setAttribute('contenteditable', 'true');
  const span = document.createElement('span');
  host.append(span);
  Object.defineProperty(span, 'isContentEditable', { value: true });
  Object.defineProperty(host, 'isContentEditable', { value: true });
  return span;
}

/**
 * Makes `navigator.platform` report the given value for this test.
 * @param platform - The platform string.
 */
function onPlatform(platform: string): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

describe('installInputModality', () => {
  let uninstall: () => void = () => {};

  beforeEach(() => {
    onPlatform('Win32');
    uninstall = installInputModality(document);
  });

  afterEach(() => {
    uninstall();
    delete document.documentElement.dataset.inputModality;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('starts in pointer modality', () => {
    expect(modality()).toBe('pointer');
  });

  it('switches to keyboard on Tab, Shift+Tab and Escape keydown', () => {
    const button = mount('button');
    for (const init of [{ key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'Escape' }]) {
      pointerDown(button);
      press(button, 'keydown', init);
      expect(modality(), JSON.stringify(init)).toBe('keyboard');
    }
  });

  it('switches to keyboard on Tab and Escape inside a text field', () => {
    const input = mount('input');
    press(input, 'keydown', { key: 'Tab' });
    expect(modality()).toBe('keyboard');
    pointerDown(input);
    press(input, 'keydown', { key: 'Escape' });
    expect(modality()).toBe('keyboard');
  });

  it('switches back to pointer on pointerdown', () => {
    const button = mount('button');
    press(button, 'keydown', { key: 'Tab' });
    pointerDown(button);
    expect(modality()).toBe('pointer');
  });

  it('switches to keyboard on an unmodified key outside editable areas', () => {
    const button = mount('button');
    press(button, 'keydown', { key: 'a' });
    expect(modality()).toBe('keyboard');
  });

  it('stays pointer when typing in an input, a textarea or a contenteditable span', () => {
    for (const target of [mount('input'), mount('textarea'), editableSpan()]) {
      press(target, 'keydown', { key: 'a' });
      press(target, 'keydown', { key: 'ArrowLeft' });
      expect(modality(), target.tagName).toBe('pointer');
    }
  });

  it('stays pointer on Ctrl or Meta chords, Tab included', () => {
    const button = mount('button');
    for (const init of [
      { key: 'z', ctrlKey: true },
      { key: 'z', metaKey: true },
      { key: 'Tab', ctrlKey: true },
      { key: 'Tab', metaKey: true },
      { key: 'Escape', ctrlKey: true },
    ]) {
      press(button, 'keydown', init);
      expect(modality(), JSON.stringify(init)).toBe('pointer');
    }
  });

  it('stays pointer on a lone modifier key, CapsLock included', () => {
    const button = mount('button');
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'NumLock']) {
      press(button, 'keydown', { key });
      expect(modality(), key).toBe('pointer');
    }
  });

  it('stays pointer on Alt chords off macOS', () => {
    const button = mount('button');
    press(button, 'keydown', { key: 'Tab', altKey: true });
    press(button, 'keydown', { key: 'a', altKey: true });
    expect(modality()).toBe('pointer');
  });

  it('switches to keyboard on Option+Tab on macOS', () => {
    uninstall();
    onPlatform('MacIntel');
    uninstall = installInputModality(document);
    const button = mount('button');
    press(button, 'keydown', { key: 'Tab', altKey: true });
    expect(modality()).toBe('keyboard');
  });

  it('stays pointer on the keys an input method owns', () => {
    const input = mount('input');
    // While composing, and the 229 the browser reports for an input method's key.
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', isComposing: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', keyCode: 229 }));
    // Escape closing the candidate list arrives after compositionend, not composing.
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    press(input, 'keydown', { key: 'Escape' });
    expect(modality()).toBe('pointer');
  });

  it('switches on a Tab that also commits an input method\'s text', () => {
    const input = mount('input');
    // Chrome: compositionend, then the Tab with its own key code.
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    press(input, 'keydown', { key: 'Tab' });
    expect(modality()).toBe('keyboard');
    // Firefox: the Tab still marked as composing.
    pointerDown(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', isComposing: true }));
    expect(modality()).toBe('keyboard');
  });

  it('switches on an Escape pressed after the composition has settled', async () => {
    const input = mount('input');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await new Promise((settle) => setTimeout(settle, 0));
    press(input, 'keydown', { key: 'Escape' });
    expect(modality()).toBe('keyboard');
  });

  it('never switches on keyup', () => {
    const button = mount('button');
    const textarea = mount('textarea');
    // Enter saved from a textarea and focus moved to a button before the key came up.
    press(textarea, 'keydown', { key: 'Enter' });
    press(button, 'keyup', { key: 'Enter' });
    // Cmd released before Z, so Z comes up with no modifier.
    press(button, 'keydown', { key: 'z', metaKey: true });
    press(button, 'keyup', { key: 'z' });
    press(button, 'keyup', { key: 'Tab' });
    expect(modality()).toBe('pointer');
  });

  it('does not switch on focus moves, scripted focus or window refocus', () => {
    const button = mount('button');
    button.focus();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    window.dispatchEvent(new FocusEvent('blur'));
    window.dispatchEvent(new FocusEvent('focus'));
    mount('button').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(modality()).toBe('pointer');
  });

  it('writes the attribute only when the modality changes', () => {
    const button = mount('button');
    press(button, 'keydown', { key: 'Tab' });
    const observer = new MutationObserver(() => {});
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-input-modality'] });
    press(button, 'keydown', { key: 'Tab' });
    press(button, 'keydown', { key: 'a' });
    const writes = observer.takeRecords();
    observer.disconnect();
    expect(writes).toHaveLength(0);
  });

  it('stops responding after uninstall', () => {
    const button = mount('button');
    uninstall();
    press(button, 'keydown', { key: 'Tab' });
    expect(modality()).toBe('pointer');
    uninstall = () => {};
  });
});
