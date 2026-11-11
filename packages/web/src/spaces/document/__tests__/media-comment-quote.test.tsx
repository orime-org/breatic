// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a comment card says it is about when the comment is on a picture, a
 * video or an audio block (inner#1316 §5.4): a picture by a thumbnail, the
 * other two by their kind's icon, and each by a name — the block's name, else
 * its caption, else the kind.
 */

import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { MediaCommentQuote } from '@web/spaces/document/DocumentCommentCard';

afterEach(cleanup);

describe('MediaCommentQuote', () => {
  it('shows a picture as a thumbnail beside its name', () => {
    render(<MediaCommentQuote media={{ blockId: 'b', type: 'image', name: 'a.png', caption: 'dawn', url: 'https://cdn.test/a.png' }} testId='q' />);

    const line = screen.getByTestId('q');
    expect(line.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/a.png');
    expect(line.textContent).toBe('a.png');
  });

  it('names a nameless block by its caption, with the kind icon for a video', () => {
    render(<MediaCommentQuote media={{ blockId: 'b', type: 'video', name: '', caption: 'ride', url: 'https://cdn.test/v.mp4' }} testId='q' />);

    const line = screen.getByTestId('q');
    expect(line.querySelector('img')).toBeNull();
    expect(line.querySelector('svg')).not.toBeNull();
    expect(line.textContent).toBe('ride');
  });

  it('names a block with neither name nor caption by its kind', () => {
    render(<MediaCommentQuote media={{ blockId: 'b', type: 'audio', name: '', caption: '', url: 'https://cdn.test/s.mp3' }} testId='q' />);

    expect(screen.getByTestId('q').textContent).toBe('Audio');
  });
});
