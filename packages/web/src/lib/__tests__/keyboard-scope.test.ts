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

  // Whether a field keeps the press depends on the key — Cmd+Z in a text box
  // is the box's own undo, while Escape there belongs to whoever put the box
  // on screen — so the outlets answer that one and this reports the region.
  describe('a field inside the region is still inside the region', () => {
    it('is true for an input inside the active region', () => {
      expect(regionOwnsKeyboard(inRegion('space', 'input'), 'space')).toBe(true);
    });

    it('is true for a textarea inside the active region', () => {
      expect(regionOwnsKeyboard(inRegion('space', 'textarea'), 'space')).toBe(
        true,
      );
    });

    it('is true for a contenteditable element inside the active region', () => {
      const el = inRegion('space', 'div');
      Object.defineProperty(el, 'isContentEditable', { value: true });
      expect(regionOwnsKeyboard(el, 'space')).toBe(true);
    });
  });

  describe('a target that passes through no region belongs to neither', () => {
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

  // Focus is not a rival answer to the active region — it is one of the
  // inputs that MOVES it, alongside a pointer press. So a target that sits in
  // either region only says "this is not an overlay"; which region acts is
  // still the store's answer.
  describe('a target inside either region defers to the active region', () => {
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

    // Pressing the chat's scrollbar hands the region to the agent without
    // moving focus, which stays on the canvas node. Delete belongs to the
    // agent from that moment, so the canvas must not act on a target that
    // still sits inside it.
    it('is false when the target sits in the asking region but the other one is active', () => {
      useUIStore.getState().setActiveRegion('agent');
      expect(regionOwnsKeyboard(inRegion('space'), 'space')).toBe(false);
    });

    it('is true for the active region when the target sits in the other one', () => {
      useUIStore.getState().setActiveRegion('space');
      expect(regionOwnsKeyboard(inRegion('agent'), 'space')).toBe(true);
    });

    it('is false for the idle region on that same target', () => {
      useUIStore.getState().setActiveRegion('space');
      expect(regionOwnsKeyboard(inRegion('agent'), 'agent')).toBe(false);
    });

    it('ignores a data-region value that names no region', () => {
      useUIStore.getState().setActiveRegion('space');
      // Not a region, and not <body> either: an overlay, so nobody's.
      expect(regionOwnsKeyboard(inRegion('sidebar'), 'space')).toBe(false);
    });
  });

  it('reads the store at call time for a <body> target', () => {
    expect(regionOwnsKeyboard(document.body, 'agent')).toBe(false);
    useUIStore.getState().setActiveRegion('agent');
    expect(regionOwnsKeyboard(document.body, 'agent')).toBe(true);
  });
});
