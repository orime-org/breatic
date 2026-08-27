// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useTrackActiveRegion } from '@web/lib/use-track-active-region';
import { useUIStore } from '@web/stores/ui';

interface Fixture {
  appRoot: HTMLElement;
  topBarButton: HTMLElement;
  agentButton: HTMLElement;
  spaceButton: HTMLElement;
  overlayButton: HTMLElement;
}

/**
 * Builds the shape of a project page: an app root holding the top bar and the
 * two region roots, plus an overlay portalled next to it under `<body>`.
 * @returns The elements a test presses or focuses.
 */
function buildPage(): Fixture {
  const appRoot = document.createElement('div');
  appRoot.id = 'root';

  const header = document.createElement('header');
  const topBarButton = document.createElement('button');
  header.append(topBarButton);

  const agent = document.createElement('aside');
  agent.setAttribute('data-region', 'agent');
  const agentButton = document.createElement('button');
  agent.append(agentButton);

  const space = document.createElement('section');
  space.setAttribute('data-region', 'space');
  const spaceButton = document.createElement('button');
  space.append(spaceButton);

  appRoot.append(header, agent, space);

  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  const overlayButton = document.createElement('button');
  overlay.append(overlayButton);

  document.body.append(appRoot, overlay);
  return { appRoot, topBarButton, agentButton, spaceButton, overlayButton };
}

/**
 * Dispatches a bubbling event of `type` from `el`.
 * @param el - Where the event starts.
 * @param type - The event type.
 */
function fire(el: Element, type: 'pointerdown' | 'focusin'): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('useTrackActiveRegion', () => {
  let page: Fixture;

  beforeEach(() => {
    page = buildPage();
    useUIStore.getState().setActiveRegion('space');
  });

  afterEach(() => {
    document.body.replaceChildren();
    useUIStore.getState().reset();
  });

  describe('a pointer press hands the region over', () => {
    it('presses inside the agent region', () => {
      renderHook(() => useTrackActiveRegion());
      fire(page.agentButton, 'pointerdown');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });

    it('presses inside the space region', () => {
      useUIStore.getState().setActiveRegion('agent');
      renderHook(() => useTrackActiveRegion());
      fire(page.spaceButton, 'pointerdown');
      expect(useUIStore.getState().activeRegion).toBe('space');
    });

    it('presses on the region root itself', () => {
      renderHook(() => useTrackActiveRegion());
      const agentRoot = page.agentButton.parentElement as Element;
      fire(agentRoot, 'pointerdown');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });
  });

  describe('focus entering a region hands it over', () => {
    it('takes the agent region when focus lands in it', () => {
      renderHook(() => useTrackActiveRegion());
      fire(page.agentButton, 'focusin');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });

    it('takes the space region when focus lands in it', () => {
      useUIStore.getState().setActiveRegion('agent');
      renderHook(() => useTrackActiveRegion());
      fire(page.spaceButton, 'focusin');
      expect(useUIStore.getState().activeRegion).toBe('space');
    });
  });

  // Each of these starts from `agent`, so a writer that wrongly claims the
  // space region shows up as a changed value rather than hiding behind the
  // initial one.
  describe('anything outside the two regions leaves it alone', () => {
    beforeEach(() => {
      useUIStore.getState().setActiveRegion('agent');
    });

    it('a press in the top bar', () => {
      renderHook(() => useTrackActiveRegion());
      fire(page.topBarButton, 'pointerdown');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });

    it('focus entering the top bar', () => {
      renderHook(() => useTrackActiveRegion());
      fire(page.topBarButton, 'focusin');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });

    it('a press in an overlay', () => {
      renderHook(() => useTrackActiveRegion());
      fire(page.overlayButton, 'pointerdown');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });

    it('focus entering an overlay', () => {
      renderHook(() => useTrackActiveRegion());
      fire(page.overlayButton, 'focusin');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });

    it('an event straight from <body>', () => {
      renderHook(() => useTrackActiveRegion());
      fire(document.body, 'focusin');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });
  });

  // The repo stops propagation before the region roots see these events:
  // `suppressTooltipFocusOpen` does it for focusin from React's delegated
  // listener on the app root, and ScrollArea's `takeOverDrag` does it for
  // pointerdown on a scrollbar rail. document's capture phase runs first.
  describe('a listener that stops propagation on the app root cannot silence it', () => {
    it('still takes the region on pointerdown', () => {
      renderHook(() => useTrackActiveRegion());
      page.appRoot.addEventListener(
        'pointerdown',
        (e) => e.stopPropagation(),
        true,
      );
      fire(page.agentButton, 'pointerdown');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });

    it('still takes the region on focusin', () => {
      renderHook(() => useTrackActiveRegion());
      page.appRoot.addEventListener(
        'focusin',
        (e) => e.stopPropagation(),
        true,
      );
      fire(page.agentButton, 'focusin');
      expect(useUIStore.getState().activeRegion).toBe('agent');
    });
  });

  // Highlighted words say "these are the ones you are working with". The space
  // being handed the region makes that untrue of any highlight living
  // elsewhere, so those go; a highlight inside the space itself is still the
  // reader's current one and stays.
  describe('taking the space region drops a highlight that lives elsewhere', () => {
    /**
     * Highlights an element's words, the way a reader dragging across them
     * would.
     * @param host - The element whose words get highlighted.
     * @returns The live selection.
     */
    const highlight = (host: HTMLElement): Selection => {
      host.textContent = 'a highlighted reply';
      const range = document.createRange();
      range.selectNodeContents(host);
      const selection = window.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection;
    };

    it('clears a highlight in the agent panel when a press hands the space over', () => {
      useUIStore.getState().setActiveRegion('agent');
      renderHook(() => useTrackActiveRegion());
      const selection = highlight(page.agentButton);
      expect(selection.isCollapsed).toBe(false);
      fire(page.spaceButton, 'pointerdown');
      expect(window.getSelection()?.isCollapsed).toBe(true);
    });

    it('clears a highlight in the agent panel when focus hands the space over', () => {
      useUIStore.getState().setActiveRegion('agent');
      renderHook(() => useTrackActiveRegion());
      highlight(page.agentButton);
      fire(page.spaceButton, 'focusin');
      expect(window.getSelection()?.isCollapsed).toBe(true);
    });

    // A press in the top bar leaves the region where it is, so a highlight
    // made there outlives every switch. What drops it is the space being
    // pressed, whether or not the space held the region a moment ago.
    it('clears a highlight in the top bar while the space is already active', () => {
      renderHook(() => useTrackActiveRegion());
      highlight(page.topBarButton);
      fire(page.spaceButton, 'pointerdown');
      expect(window.getSelection()?.isCollapsed).toBe(true);
    });

    // Selecting a paragraph in a document space and extending it with a
    // shift-click needs that first selection as its anchor.
    it('keeps a highlight that sits in the space itself', () => {
      renderHook(() => useTrackActiveRegion());
      const selection = highlight(page.spaceButton);
      fire(page.spaceButton, 'pointerdown');
      expect(selection.isCollapsed).toBe(false);
      expect(window.getSelection()?.toString()).toBe('a highlighted reply');
    });

    it('leaves it alone when the agent region takes over', () => {
      renderHook(() => useTrackActiveRegion());
      const selection = highlight(page.agentButton);
      fire(page.agentButton, 'pointerdown');
      expect(selection.isCollapsed).toBe(false);
    });
  });

  it('stops tracking once unmounted', () => {
    const { unmount } = renderHook(() => useTrackActiveRegion());
    unmount();
    fire(page.agentButton, 'pointerdown');
    expect(useUIStore.getState().activeRegion).toBe('space');
  });
});
