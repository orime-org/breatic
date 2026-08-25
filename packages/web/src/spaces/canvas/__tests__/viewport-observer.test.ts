// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';

import { observeViewportTransform } from '@web/spaces/canvas/viewport-observer';

const made: HTMLElement[] = [];

/**
 * Put a stand-in for the canvas viewport in the document.
 * @returns The element, removed after the test.
 */
function mountViewport(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'react-flow__viewport';
  document.body.appendChild(el);
  made.push(el);
  return el;
}

/**
 * Let the MutationObserver deliver its records.
 * @returns A promise resolved after the microtask queue drains.
 */
function delivered(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const el of made.splice(0)) el.remove();
});

describe('observeViewportTransform', () => {
  it('calls back when the viewport transform changes', async () => {
    const viewport = mountViewport();
    const onChange = vi.fn();
    observeViewportTransform(onChange);

    viewport.style.transform = 'translate(10px, 20px) scale(1)';
    await delivered();

    expect(onChange).toHaveBeenCalled();
  });

  it('stops calling back once disconnected', async () => {
    const viewport = mountViewport();
    const onChange = vi.fn();
    const stop = observeViewportTransform(onChange);
    stop();

    viewport.style.transform = 'translate(10px, 20px) scale(1)';
    await delivered();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores attributes other than style', async () => {
    // ReactFlow writes pan and zoom into the inline style. Watching every
    // attribute would also fire on the class changes the canvas makes while
    // picking, which move nothing.
    const viewport = mountViewport();
    const onChange = vi.fn();
    observeViewportTransform(onChange);

    viewport.setAttribute('data-something', 'x');
    viewport.className = 'react-flow__viewport canvas-pick-dimmed';
    await delivered();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('hands back a no-op teardown when there is no canvas', () => {
    // Unit tests and non-canvas routes have no viewport element; observing
    // must stay silent rather than throw.
    const onChange = vi.fn();
    const stop = observeViewportTransform(onChange);

    expect(() => stop()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
