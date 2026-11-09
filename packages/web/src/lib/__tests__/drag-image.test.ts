// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it } from 'vitest';

import { DRAG_IMAGE_CLASS, DRAG_IMAGE_LONGEST_SIDE, dragImageScale, mountDragImage } from '@web/lib/drag-image';

describe('dragImageScale', () => {
  it('fits the width to 512 when the content is wider than tall', () => {
    expect(dragImageScale(768, 40)).toBeCloseTo(DRAG_IMAGE_LONGEST_SIDE / 768);
  });

  it('fits the height to 512 when the content is taller than wide', () => {
    expect(dragImageScale(300, 1200)).toBeCloseTo(DRAG_IMAGE_LONGEST_SIDE / 1200);
  });

  it('keeps content no longer than 512 on any side at its own size', () => {
    expect(dragImageScale(121, 127)).toBe(1);
    expect(dragImageScale(512, 40)).toBe(1);
  });
});

describe('mountDragImage', () => {
  afterEach(() => {
    document.querySelectorAll(`.${DRAG_IMAGE_CLASS}`).forEach((el) => el.remove());
  });

  it('puts the content on the page in an opaque root sized to the scaled content', () => {
    const content = document.createElement('div');
    const { root, scale } = mountDragImage(document, content, () => ({ width: 1024, height: 256 }));
    expect(root.isConnected).toBe(true);
    expect(root.classList.contains(DRAG_IMAGE_CLASS)).toBe(true);
    expect(scale).toBe(0.5);
    expect([root.style.width, root.style.height]).toEqual(['512px', '128px']);
    const layer = root.firstElementChild as HTMLElement;
    expect(layer.style.transform).toBe('scale(0.5)');
    expect(layer.contains(content)).toBe(true);
    expect([root, ...root.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.opacity !== '')).toEqual([]);
  });

  it('leaves the page at the drag\'s next event once the browser has the image', () => {
    const { root } = mountDragImage(document, document.createElement('div'), () => ({ width: 10, height: 10 }));
    window.dispatchEvent(new Event('drag'));
    expect(root.isConnected).toBe(false);
  });
});
