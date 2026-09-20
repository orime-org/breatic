// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A2: what the strip keeps watching, and for how long.
 *
 * The offset the handle sits at is a function of the hovered row's geometry,
 * so the row is watched for as long as the strip points at it. The row's
 * element is not a fixed thing: ProseMirror rebuilds a block container when
 * the document around it changes — measured 2026-09-18 in this suite, a move
 * leaves the old `[data-id]` element detached and puts a new one in its place,
 * and this branch's own drop performs exactly that move. A watcher left on the
 * detached element never reports again.
 *
 * Geometry is not what these cases read: jsdom has no layout, so every box is
 * zero. What they read is WHICH element is being watched, which is the part
 * that goes wrong.
 */

import { render } from '@testing-library/react';
import * as React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import { useStripOnFirstLine } from '@web/spaces/document/document-strip-alignment';

/** Every element a `ResizeObserver` was pointed at, in order. */
let watched: Element[] = [];
/** How many observers were disconnected. */
let disconnects = 0;
let realResizeObserver: unknown;

beforeEach(() => {
  watched = [];
  disconnects = 0;
  realResizeObserver = (globalThis as unknown as { ResizeObserver: unknown })
    .ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      /** Records the element. @param target - What to watch. */
      observe(target: Element): void {
        watched.push(target);
      }
      /** Records the drop. */
      disconnect(): void {
        disconnects += 1;
      }
      /** Unused by the hook. */
      unobserve(): void {}
    };
});

afterEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    realResizeObserver;
  vi.restoreAllMocks();
});

/** A body holding one row that carries the given id. */
interface Body {
  body: HTMLElement;
  container: HTMLElement;
}

/**
 * Builds a body with one row in it.
 * @param blockId - The id the row carries.
 * @returns The body and the row's container.
 */
function aBodyWith(blockId: string): Body {
  const body = document.createElement('div');
  const container = document.createElement('div');
  container.setAttribute('data-id', blockId);
  const content = document.createElement('p');
  content.className = 'bn-block-content';
  container.appendChild(content);
  body.appendChild(container);
  document.body.appendChild(body);
  return { body, container };
}

/**
 * Mounts the strip against that body.
 * @param blockId - Which row the strip points at.
 * @param body - The editor surface.
 * @returns The rendered result, for unmounting.
 */
function mountStrip(
  blockId: string,
  body: HTMLElement,
): ReturnType<typeof render> {
  /** A strip that registers itself with the hook. */
  function Strip(): React.JSX.Element {
    const { ref } = useStripOnFirstLine(blockId, body);
    return <div ref={ref} data-testid='strip' />;
  }
  return render(<Strip />);
}

/**
 * Lets the MutationObserver's microtask run.
 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('what the strip watches', () => {
  it('watches the row it points at', () => {
    const { body, container } = aBodyWith('row-1');

    mountStrip('row-1', body);

    expect(watched).toEqual([container]);
  });

  it('follows the row onto the element that replaces it', async () => {
    const { body, container } = aBodyWith('row-1');
    mountStrip('row-1', body);
    expect(watched).toEqual([container]);

    // What a move does: the old element leaves the tree and an element
    // carrying the same id takes its place.
    const rebuilt = document.createElement('div');
    rebuilt.setAttribute('data-id', 'row-1');
    const content = document.createElement('p');
    content.className = 'bn-block-content';
    rebuilt.appendChild(content);
    container.replaceWith(rebuilt);
    await settle();

    expect(watched[watched.length - 1]).toBe(rebuilt);
    expect(disconnects).toBeGreaterThan(0);
  });

  it('keeps watching the same element when the row is only reshaped', async () => {
    const { body, container } = aBodyWith('row-1');
    mountStrip('row-1', body);

    // A type change swaps the content element; the container stays.
    const heading = document.createElement('h1');
    heading.className = 'bn-block-content';
    container.querySelector('.bn-block-content')?.replaceWith(heading);
    await settle();

    expect(watched).toEqual([container]);
  });
});
