// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A file dropped where nothing on the page takes it is not opened by the
 * browser in place of the app (inner#1127).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { guardStrayFileDrops } from '@web/lib/stray-file-drop';

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = '';
});

/**
 * A drag event carrying files, or text, as the browser fires it.
 * @param type - `dragover` or `drop`.
 * @param types - What the drag carries.
 * @returns The event and its transfer.
 */
function drag(type: 'dragover' | 'drop', types: string[]): { event: Event; transfer: { dropEffect: string } } {
  const transfer = { types, dropEffect: 'copy' };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return { event, transfer };
}

describe('a file dragged where nothing takes it', () => {
  it.each(['dragover', 'drop'] as const)('has its %s taken, and shows it cannot land', (type) => {
    uninstall = guardStrayFileDrops(window);
    const target = document.body.appendChild(document.createElement('div'));
    const { event, transfer } = drag(type, ['Files']);

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('none');
  });

  it('leaves a drag that something on the page took as that handler set it', () => {
    uninstall = guardStrayFileDrops(window);
    const target = document.body.appendChild(document.createElement('div'));
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    const { event, transfer } = drag('dragover', ['Files']);

    target.dispatchEvent(event);

    expect(transfer.dropEffect).toBe('copy');
  });

  it('leaves a drag of text alone', () => {
    uninstall = guardStrayFileDrops(window);
    const target = document.body.appendChild(document.createElement('div'));
    const { event } = drag('drop', ['text/plain']);

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
