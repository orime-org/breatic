// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { regionOwnsKeyboard } from '@web/lib/keyboard-scope';
import { useUIStore } from '@web/stores/ui';

/**
 * Builds `<div data-region={region}><child/></div>` in the document and
 * returns the child, so `closest('[data-region]')` walks a real tree.
 * @param region - The value for the `data-region` attribute.
 * @param tag - Tag name for the child element.
 * @returns The child element, attached to the document.
 */
function inRegion(region: string, tag = 'button'): Element {
  const root = document.createElement('div');
  root.setAttribute('data-region', region);
  const child = document.createElement(tag);
  root.append(child);
  document.body.append(root);
  return child;
}

describe('regionOwnsKeyboard', () => {
  beforeEach(() => {
    useUIStore.getState().setActiveRegion('space');
  });

  afterEach(() => {
    document.body.replaceChildren();
    useUIStore.getState().reset();
  });

  it('is false for a target that is not an Element', () => {
    expect(regionOwnsKeyboard(null, 'space')).toBe(false);
    expect(regionOwnsKeyboard(document, 'space')).toBe(false);
  });

  describe('an editable target keeps its own keys', () => {
    it('is false for an input inside the active region', () => {
      expect(regionOwnsKeyboard(inRegion('space', 'input'), 'space')).toBe(
        false,
      );
    });

    it('is false for a textarea inside the active region', () => {
      expect(regionOwnsKeyboard(inRegion('space', 'textarea'), 'space')).toBe(
        false,
      );
    });

    it('is false for a contenteditable element inside the active region', () => {
      const el = inRegion('space', 'div');
      Object.defineProperty(el, 'isContentEditable', { value: true });
      expect(regionOwnsKeyboard(el, 'space')).toBe(false);
    });
  });

  describe('an overlay keeps its own keys', () => {
    it('is false for a target whose ancestors pass through no region', () => {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      const child = document.createElement('button');
      overlay.append(child);
      document.body.append(overlay);
      expect(regionOwnsKeyboard(child, 'space')).toBe(false);
    });

    it('is false for a target in the top bar, which is not a region', () => {
      const header = document.createElement('header');
      const child = document.createElement('button');
      header.append(child);
      document.body.append(header);
      expect(regionOwnsKeyboard(child, 'space')).toBe(false);
    });
  });

  describe('<body> means no element holds focus, so the active region decides', () => {
    it('is true for the asking region when it is active', () => {
      expect(regionOwnsKeyboard(document.body, 'space')).toBe(true);
    });

    it('is false for the asking region when the other one is active', () => {
      useUIStore.getState().setActiveRegion('agent');
      expect(regionOwnsKeyboard(document.body, 'space')).toBe(false);
    });
  });

  // A target that sits in a region is that region's, whichever region the
  // store says is active. For a key press the two agree anyway — focus
  // entering a region writes it — but a copy event's target follows the
  // SELECTION, and a selection outlives the focus move that left it behind.
  describe('a target inside a region belongs to that region', () => {
    it('is true when the target sits in the asking region and it is active', () => {
      expect(regionOwnsKeyboard(inRegion('space'), 'space')).toBe(true);
    });

    it('is false when the target sits in the other region', () => {
      useUIStore.getState().setActiveRegion('agent');
      expect(regionOwnsKeyboard(inRegion('agent'), 'space')).toBe(false);
    });

    it('is true for the agent region when the agent region is active', () => {
      useUIStore.getState().setActiveRegion('agent');
      expect(regionOwnsKeyboard(inRegion('agent'), 'agent')).toBe(true);
    });

    it('is true when the target sits in the asking region and the other one is active', () => {
      useUIStore.getState().setActiveRegion('agent');
      expect(regionOwnsKeyboard(inRegion('space'), 'space')).toBe(true);
    });

    // The case that sends a highlighted chat reply to the clipboard: the
    // reader drags across a reply (region 'agent'), then right-clicks a canvas
    // node — the press hands the region to the space, and a right-click does
    // not collapse the selection. The copy event that follows still targets
    // the chat, and it is the chat's.
    it('is false for the space region when the target sits in the agent region', () => {
      useUIStore.getState().setActiveRegion('space');
      expect(regionOwnsKeyboard(inRegion('agent'), 'space')).toBe(false);
    });

    it('is true for the agent region on that same target', () => {
      useUIStore.getState().setActiveRegion('space');
      expect(regionOwnsKeyboard(inRegion('agent'), 'agent')).toBe(true);
    });

    it('ignores a data-region value that names no region', () => {
      useUIStore.getState().setActiveRegion('space');
      // Not a region, and not <body> either: nobody's.
      expect(regionOwnsKeyboard(inRegion('sidebar'), 'space')).toBe(false);
    });
  });

  it('reads the store at call time for a <body> target', () => {
    expect(regionOwnsKeyboard(document.body, 'agent')).toBe(false);
    useUIStore.getState().setActiveRegion('agent');
    expect(regionOwnsKeyboard(document.body, 'agent')).toBe(true);
  });
});
