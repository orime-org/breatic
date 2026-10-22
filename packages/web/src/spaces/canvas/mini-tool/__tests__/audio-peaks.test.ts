// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading an audio source's peaks file for the cut band (inner#1305 §4.4).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SharedModule from '@breatic/shared';

const httpRequest = vi.hoisted(() => vi.fn());

vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  httpRequest,
}));

const { fetchAudioPeaks } = await import('@web/spaces/canvas/mini-tool/audio-peaks');

const AUDIO = 'https://resource-dev.breatic.cc/audio/2026-10-21/1792580000000_18f58aed-b802-4243-a8ea-02d377de9679.mp3';

beforeEach(() => {
  httpRequest.mockReset();
});

describe('fetchAudioPeaks', () => {
  it('reads the file beside the audio and answers its peaks', async () => {
    httpRequest.mockResolvedValue(new Response(JSON.stringify({ version: 1, peaks: [0, 128, 255] }), { status: 200 }));

    expect(await fetchAudioPeaks(AUDIO, new AbortController().signal)).toEqual([0, 128, 255]);
    expect(httpRequest.mock.calls[0]?.[0]).toBe(`${AUDIO}.peaks.json`);
    expect(httpRequest.mock.calls[0]?.[2]).toMatchObject({ replaySafe: true });
  });

  it('answers missing when the file is not there yet', async () => {
    httpRequest.mockResolvedValue(new Response('Not found', { status: 404 }));

    expect(await fetchAudioPeaks(AUDIO, new AbortController().signal)).toBe('missing');
  });

  it('answers missing when the request did not get through', async () => {
    httpRequest.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await fetchAudioPeaks(AUDIO, new AbortController().signal)).toBe('missing');
  });

  it('answers invalid for a file that is not a peaks file', async () => {
    httpRequest.mockResolvedValue(new Response(JSON.stringify({ version: 2, peaks: [1] }), { status: 200 }));
    expect(await fetchAudioPeaks(AUDIO, new AbortController().signal)).toBe('invalid');

    httpRequest.mockResolvedValue(new Response('<html>', { status: 200 }));
    expect(await fetchAudioPeaks(AUDIO, new AbortController().signal)).toBe('invalid');
  });

  it('asks nothing for an address that names no stored object', async () => {
    expect(await fetchAudioPeaks('https://example.com/song.mp3', new AbortController().signal)).toBe('invalid');
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
