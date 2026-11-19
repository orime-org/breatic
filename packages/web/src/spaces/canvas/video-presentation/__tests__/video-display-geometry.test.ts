// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { readVideoDisplayGeometry } from '../video-display-geometry';

describe('canonical video geometry for node overlays', () => {
  it('uses canonical display layout offsets and dimensions while the packed decoder has twice the width', () => {
    const wrapper = document.createElement('div');
    const decoder = document.createElement('video');
    decoder.dataset.testid = 'media-element';
    Object.defineProperties(decoder, { videoWidth: { value: 320 }, videoHeight: { value: 240 }, offsetWidth: { value: 0 }, offsetHeight: { value: 0 } });
    const display = document.createElement('div');
    display.dataset.canonicalVideoDisplay = 'https://assets.example.test/canonical.webm';
    Object.defineProperties(display, { offsetParent: { value: wrapper }, offsetLeft: { value: 8 }, offsetTop: { value: 12 }, offsetWidth: { value: 160 }, offsetHeight: { value: 240 } });
    const transformed = vi.spyOn(display, 'getBoundingClientRect').mockReturnValue({ left: 40, top: 60, width: 800, height: 1200 } as DOMRect);
    wrapper.append(decoder, display);
    expect(readVideoDisplayGeometry(wrapper)).toEqual({ element: display, at: { x: 8, y: 12 }, box: { width: 160, height: 240 }, src: 'https://assets.example.test/canonical.webm' });
    expect(transformed).not.toHaveBeenCalled();
    transformed.mockRestore();
  });

  it('never substitutes decoder geometry when the actual canonical display has no measured box', () => {
    const wrapper = document.createElement('div');
    const decoder = document.createElement('video'); decoder.dataset.testid = 'media-element';
    Object.defineProperties(decoder, { offsetWidth: { value: 320 }, offsetHeight: { value: 240 } });
    wrapper.append(decoder);
    expect(readVideoDisplayGeometry(wrapper)).toBeNull();
    const display = document.createElement('div'); display.dataset.canonicalVideoDisplay = 'https://assets.example.test/source.webm';
    wrapper.append(display);
    expect(readVideoDisplayGeometry(wrapper)).toBeNull();
  });
});
