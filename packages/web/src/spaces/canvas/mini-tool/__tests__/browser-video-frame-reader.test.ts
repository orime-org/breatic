// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Raw decoding and resource ownership only; presentation windows belong to the caller (inner#1306). */
import type { InputVideoTrack, UrlSourceOptions, VideoSample } from 'mediabunny';
import type * as Mediabunny from 'mediabunny';
import type * as Shared from '@breatic/shared';
import { InputDisposedError, UnsupportedInputFormatError } from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BrowserVideoReadError, readBrowserVideoFrameTable } from '@web/spaces/canvas/mini-tool/browser-video-frame-reader';

const boundary = vi.hoisted(() => ({
  input: vi.fn(),
  source: vi.fn(),
  sink: vi.fn(),
  httpRequest: vi.fn(),
  nakedFetch: vi.fn(),
}));

vi.mock('mediabunny', async (importOriginal) => ({
  ...await importOriginal<typeof Mediabunny>(),
  Input: vi.fn(function (options: { source: MockSource }): MockInput {
    return boundary.input(options) as MockInput;
  }),
  UrlSource: vi.fn(function (url: string | URL | Request, options?: UrlSourceOptions): MockSource {
    return boundary.source(url, options) as MockSource;
  }),
  VideoSampleSink: vi.fn(function (track: MockTrack): MockSink {
    return boundary.sink(track) as MockSink;
  }),
}));

vi.mock('@breatic/shared', async (importOriginal) => ({
  ...await importOriginal<typeof Shared>(),
  httpRequest: boundary.httpRequest,
}));

type MockSample = Pick<VideoSample, 'timestamp' | 'duration' | 'displayWidth' | 'displayHeight'> & {
  close: Mock<VideoSample['close']>;
};

interface MockTrack {
  canDecode: Mock<InputVideoTrack['canDecode']>;
  computeDuration: Mock<InputVideoTrack['computeDuration']>;
  getDisplayWidth: Mock<InputVideoTrack['getDisplayWidth']>;
  getDisplayHeight: Mock<InputVideoTrack['getDisplayHeight']>;
  getTimeResolution: Mock<InputVideoTrack['getTimeResolution']>;
}

interface MockInput {
  disposed: boolean;
  getPrimaryVideoTrack: Mock<() => Promise<MockTrack | null>>;
  computeDuration: Mock<() => Promise<number>>;
  getDurationFromMetadata: Mock<() => Promise<number | null>>;
  dispose: Mock<() => void>;
}

interface MockSource {
  url: string;
  options: UrlSourceOptions;
}

interface MockSink {
  samples: Mock<(start?: number, end?: number) => AsyncGenerator<MockSample, void, unknown>>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface Fixture {
  url: string;
  source?: MockSource;
  input: MockInput;
  track: MockTrack;
  sink: MockSink;
  samples: MockSample[];
  onDispose?: () => void;
}

const fixtures = new Map<string, Fixture>();

/** A gate controlled by the test, without timers or scheduling assumptions. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

/** A sample exposes only real VideoSample properties and its owned close operation. */
function sample(timestamp: number, duration = 0.125, width = 256, height = 128): MockSample {
  return { timestamp, duration, displayWidth: width, displayHeight: height, close: vi.fn() };
}

/** A minimal external engine fixture; none of the adapter logic is mocked. */
function fixture(samples = [sample(0), sample(0.125), sample(0.25)], name = 'source'): Fixture {
  const track: MockTrack = {
    canDecode: vi.fn().mockResolvedValue(true),
    computeDuration: vi.fn().mockResolvedValue(0.375),
    getDisplayWidth: vi.fn().mockResolvedValue(256),
    getDisplayHeight: vi.fn().mockResolvedValue(128),
    getTimeResolution: vi.fn().mockResolvedValue(16384),
  };
  const sink: MockSink = {
    samples: vi.fn(async function* (): AsyncGenerator<MockSample, void, unknown> {
      yield* samples;
    }),
  };
  const input: MockInput = {
    disposed: false,
    getPrimaryVideoTrack: vi.fn().mockResolvedValue(track),
    computeDuration: vi.fn().mockResolvedValue(0.375),
    getDurationFromMetadata: vi.fn().mockResolvedValue(0.375),
    dispose: vi.fn(),
  };
  const item: Fixture = { url: `https://media.example.invalid/${name}.mp4`, input, track, sink, samples };
  input.dispose.mockImplementation(() => {
    if (input.disposed) return;
    input.disposed = true;
    item.onDispose?.();
  });
  fixtures.set(item.url, item);
  return item;
}

/** Obtain the actual HTTP adapter handed to the third-party source. */
function fetchFor(item: Fixture): typeof fetch {
  const fetchFn = item.source?.options.fetchFn;
  if (fetchFn === undefined) throw new Error('UrlSource was not given an HTTP adapter');
  return fetchFn;
}

/** Start a read with a stable source identity. */
function read(item: Fixture, signal = new AbortController().signal): ReturnType<typeof readBrowserVideoFrameTable> {
  return readBrowserVideoFrameTable({ url: item.url, sourceKey: item.url, signal });
}

/** Attach rejection handling before a deliberately interrupted asynchronous operation. */
function observe(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

/** Check error classification without coupling tests to incidental error wording. */
function expectReadError(error: unknown, code: string, cause?: unknown): void {
  expect(error).toBeInstanceOf(BrowserVideoReadError);
  expect(error).toHaveProperty('code', code);
  if (cause !== undefined) expect(error).toHaveProperty('cause', cause);
}

/** Assert resource release independently of the returned metadata. */
function expectReleased(item: Fixture, acquired = item.samples): void {
  expect(item.input.disposed).toBe(true);
  for (const frame of acquired) expect(frame.close).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  fixtures.clear();
  for (const mock of Object.values(boundary)) mock.mockReset();
  boundary.nakedFetch.mockRejectedValue(new Error('The media reader must use shared HTTP'));
  vi.stubGlobal('fetch', boundary.nakedFetch);
  boundary.source.mockImplementation((url: string | URL | Request, options: UrlSourceOptions = {}): MockSource => ({
    url: url instanceof Request ? url.url : String(url), options,
  }));
  boundary.input.mockImplementation(({ source }: { source: MockSource }): MockInput => {
    const item = fixtures.get(source.url);
    if (item === undefined) throw new Error('Unexpected input URL');
    item.source = source;
    return item.input;
  });
  boundary.sink.mockImplementation((track: MockTrack): MockSink => {
    const item = [...fixtures.values()].find((candidate) => candidate.track === track);
    if (item === undefined) throw new Error('Unexpected video track');
    return item.sink;
  });
});

afterEach(() => {
  expect(boundary.nakedFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readBrowserVideoFrameTable raw facts', () => {
  it('returns the complete VFR presentation-order table and keeps independent duration readings', async () => {
    const item = fixture([
      sample(0, 0.0625), sample(0.0625, 0.125), sample(0.1875, 0.25), sample(0.4375, 0.3125),
      sample(0.75, 1.0625), sample(1.8125, 1.625), sample(3.4375, 1.5), sample(4.9375, 0.25),
    ]);
    item.track.computeDuration.mockResolvedValue(5.1875);
    item.input.computeDuration.mockResolvedValue(5.1875);
    item.input.getDurationFromMetadata.mockResolvedValue(5);

    expect(await read(item)).toEqual({
      status: 'ready', sourceKey: item.url, timeResolution: 16384, displayWidth: 256, displayHeight: 128,
      durationReadings: { videoTrackComputedEndSeconds: 5.1875, inputComputedEndSeconds: 5.1875, inputMetadataEndSeconds: 5 },
      frames: [
        { frameIndex: 0, timestampSeconds: 0, durationSeconds: 0.0625, displayWidth: 256, displayHeight: 128 },
        { frameIndex: 1, timestampSeconds: 0.0625, durationSeconds: 0.125, displayWidth: 256, displayHeight: 128 },
        { frameIndex: 2, timestampSeconds: 0.1875, durationSeconds: 0.25, displayWidth: 256, displayHeight: 128 },
        { frameIndex: 3, timestampSeconds: 0.4375, durationSeconds: 0.3125, displayWidth: 256, displayHeight: 128 },
        { frameIndex: 4, timestampSeconds: 0.75, durationSeconds: 1.0625, displayWidth: 256, displayHeight: 128 },
        { frameIndex: 5, timestampSeconds: 1.8125, durationSeconds: 1.625, displayWidth: 256, displayHeight: 128 },
        { frameIndex: 6, timestampSeconds: 3.4375, durationSeconds: 1.5, displayWidth: 256, displayHeight: 128 },
        { frameIndex: 7, timestampSeconds: 4.9375, durationSeconds: 0.25, displayWidth: 256, displayHeight: 128 },
      ],
    });
    const [start, end] = item.sink.samples.mock.calls[0] ?? [];
    expect([undefined, -Infinity]).toContain(start);
    expect([undefined, Infinity]).toContain(end);
    expectReleased(item);
  });

  it('does not shift positive timestamps, discard negative ones or merge distinct samples with equal PTS', async () => {
    const item = fixture([sample(-0.125), sample(0.25), sample(0.25, 0), sample(0.375)]);
    item.input.getDurationFromMetadata.mockResolvedValue(null);
    const result = await read(item);
    expect(result).toMatchObject({
      status: 'ready',
      durationReadings: { inputMetadataEndSeconds: null },
      frames: [
        { frameIndex: 0, timestampSeconds: -0.125, durationSeconds: 0.125 },
        { frameIndex: 1, timestampSeconds: 0.25, durationSeconds: 0.125 },
        { frameIndex: 2, timestampSeconds: 0.25, durationSeconds: 0 },
        { frameIndex: 3, timestampSeconds: 0.375, durationSeconds: 0.125 },
      ],
    });
    const [start, end] = item.sink.samples.mock.calls[0] ?? [];
    expect([undefined, -Infinity]).toContain(start);
    expect([undefined, Infinity]).toContain(end);
    expectReleased(item);
  });

  it('keeps an audio tail separate and does not generate extra video frames from the file end', async () => {
    const item = fixture([sample(0), sample(2)]);
    item.track.computeDuration.mockResolvedValue(2.125);
    item.input.computeDuration.mockResolvedValue(4);
    item.input.getDurationFromMetadata.mockResolvedValue(4);
    expect(await read(item)).toMatchObject({
      durationReadings: { videoTrackComputedEndSeconds: 2.125, inputComputedEndSeconds: 4, inputMetadataEndSeconds: 4 },
      frames: [{ frameIndex: 0, timestampSeconds: 0 }, { frameIndex: 1, timestampSeconds: 2 }],
    });
    expectReleased(item);
  });

  it('retains the track display size and the actual display size of each sample', async () => {
    const item = fixture([sample(0, 0.125, 128, 256), sample(0.125, 0.125, 320, 180)]);
    item.track.getDisplayWidth.mockResolvedValue(128);
    item.track.getDisplayHeight.mockResolvedValue(256);
    expect(await read(item)).toMatchObject({
      displayWidth: 128, displayHeight: 256,
      frames: [{ displayWidth: 128, displayHeight: 256 }, { displayWidth: 320, displayHeight: 180 }],
    });
    expectReleased(item);
  });

  it.each(['ready', 'failed', 'unsupported'] as const)('removes its abort listener after a %s read', async (outcome) => {
    const item = fixture();
    if (outcome === 'failed') item.input.getPrimaryVideoTrack.mockRejectedValue(new Error('Broken media'));
    if (outcome === 'unsupported') item.track.canDecode.mockResolvedValue(false);
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    await observe(read(item, controller.signal));
    const listeners = added.mock.calls.filter(([event]) => event === 'abort').map(([, listener]) => listener);
    expect(listeners).toEqual(expect.arrayContaining([expect.any(Function)]));
    for (const listener of listeners) {
      expect(removed.mock.calls.some(([event, removedListener]) => event === 'abort' && removedListener === listener)).toBe(true);
    }
    expectReleased(item, outcome === 'ready' ? item.samples : []);
  });
});

describe('readBrowserVideoFrameTable capability and errors', () => {
  it('reports unsupported format by its typed error and releases the input', async () => {
    const item = fixture();
    item.input.getPrimaryVideoTrack.mockRejectedValue(new UnsupportedInputFormatError('Unrecognized container'));
    expect(await read(item)).toEqual({ status: 'unsupported', sourceKey: item.url, reason: 'unsupported-format' });
    expectReleased(item, []);
    expect(item.sink.samples).not.toHaveBeenCalled();
    expect(boundary.httpRequest).not.toHaveBeenCalled();
  });

  it('reports decoder capability without attempting to consume samples or running a fallback', async () => {
    const item = fixture();
    item.track.canDecode.mockResolvedValue(false);
    expect(await read(item)).toEqual({ status: 'unsupported', sourceKey: item.url, reason: 'video-decoder-unavailable' });
    expectReleased(item, []);
    expect(item.sink.samples).not.toHaveBeenCalled();
    expect(boundary.httpRequest).not.toHaveBeenCalled();
  });

  it('distinguishes no video track from an empty decoded video', async () => {
    const noVideo = fixture([], 'audio-only');
    noVideo.input.getPrimaryVideoTrack.mockResolvedValue(null);
    expectReadError(await observe(read(noVideo)), 'no-video');
    expectReleased(noVideo);
    const empty = fixture([], 'empty-video');
    expectReadError(await observe(read(empty)), 'empty-video');
    expectReleased(empty);
  });

  it.each(['track', 'capability', 'duration', 'file-duration', 'metadata', 'size'] as const)('classifies a %s read failure as invalid media', async (phase) => {
    const item = fixture();
    const cause = new Error('Corrupt metadata');
    if (phase === 'track') item.input.getPrimaryVideoTrack.mockRejectedValue(cause);
    if (phase === 'capability') item.track.canDecode.mockRejectedValue(cause);
    if (phase === 'duration') item.track.computeDuration.mockRejectedValue(cause);
    if (phase === 'file-duration') item.input.computeDuration.mockRejectedValue(cause);
    if (phase === 'metadata') item.input.getDurationFromMetadata.mockRejectedValue(cause);
    if (phase === 'size') item.track.getDisplayWidth.mockRejectedValue(cause);
    expectReadError(await observe(read(item)), 'invalid-media', cause);
    expectReleased(item, []);
  });

  it('closes the current sample when one of its properties throws', async () => {
    const item = fixture();
    const cause = new Error('Sample metadata could not be read');
    Object.defineProperty(item.samples[1], 'timestamp', { get: () => { throw cause; } });
    expectReadError(await observe(read(item)), 'decode-failed', cause);
    expectReleased(item, item.samples.slice(0, 2));
    expect(item.samples[2]?.close).not.toHaveBeenCalled();
  });

  it('does not return a partial table after the decoder fails', async () => {
    const item = fixture();
    const cause = new Error('Decoder stopped');
    item.sink.samples.mockImplementation(async function* (): AsyncGenerator<MockSample, void, unknown> {
      yield item.samples[0];
      yield item.samples[1];
      throw cause;
    });
    expectReadError(await observe(read(item)), 'decode-failed', cause);
    expectReleased(item, item.samples.slice(0, 2));
    expect(item.samples[2]?.close).not.toHaveBeenCalled();
  });

  it('does not infer capability from an error message', async () => {
    const item = fixture();
    const cause = new Error('UnsupportedInputFormatError: VideoDecoder is not supported');
    item.input.getPrimaryVideoTrack.mockRejectedValue(cause);
    expectReadError(await observe(read(item)), 'invalid-media', cause);
    expectReleased(item, []);
  });
});

describe('readBrowserVideoFrameTable cancellation', () => {
  it('does not construct an input or make a request when already aborted', async () => {
    const item = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await observe(read(item, controller.signal))).toHaveProperty('name', 'AbortError');
    expect(boundary.input).not.toHaveBeenCalled();
    expect(boundary.source).not.toHaveBeenCalled();
    expect(boundary.httpRequest).not.toHaveBeenCalled();
  });

  it.each(['track', 'duration'] as const)('disposes a pending %s read when aborted', async (phase) => {
    const item = fixture();
    const entered = deferred<void>();
    const blocked = deferred<never>();
    item.onDispose = () => blocked.reject(new InputDisposedError());
    if (phase === 'track') item.input.getPrimaryVideoTrack.mockImplementation(() => { entered.resolve(); return blocked.promise; });
    if (phase === 'duration') item.track.computeDuration.mockImplementation(() => { entered.resolve(); return blocked.promise; });
    const controller = new AbortController();
    const outcome = observe(read(item, controller.signal));
    await entered.promise;
    controller.abort();
    expect(item.input.disposed).toBe(true);
    expect(await outcome).toHaveProperty('name', 'AbortError');
    expectReleased(item, []);
  });

  it('closes a sample arriving after cancellation and never publishes the stale table', async () => {
    const item = fixture();
    const entered = deferred<void>();
    const late = deferred<void>();
    const closed = deferred<void>();
    const iteratorReleased = deferred<void>();
    item.samples[1].close.mockImplementation(() => closed.resolve());
    item.sink.samples.mockImplementation(async function* (): AsyncGenerator<MockSample, void, unknown> {
      try {
        yield item.samples[0];
        entered.resolve();
        await late.promise;
        yield item.samples[1];
      } finally {
        iteratorReleased.resolve();
      }
    });
    const controller = new AbortController();
    const outcome = observe(read(item, controller.signal));
    await entered.promise;
    controller.abort();
    expect(item.input.disposed).toBe(true);
    late.resolve();
    await closed.promise;
    await iteratorReleased.promise;
    expect(await outcome).toHaveProperty('name', 'AbortError');
    expectReleased(item, item.samples.slice(0, 2));
    expect(item.samples[2]?.close).not.toHaveBeenCalled();
  });

  it('keeps concurrent sources isolated when an older read completes late', async () => {
    const old = fixture([sample(0.25)], 'old');
    const current = fixture([sample(2)], 'current');
    const entered = deferred<void>();
    const late = deferred<void>();
    const closed = deferred<void>();
    old.samples[0].close.mockImplementation(() => closed.resolve());
    old.sink.samples.mockImplementation(async function* (): AsyncGenerator<MockSample, void, unknown> {
      entered.resolve();
      await late.promise;
      yield old.samples[0];
    });
    const controller = new AbortController();
    const oldOutcome = observe(read(old, controller.signal));
    await entered.promise;
    controller.abort();
    expect(await read(current)).toMatchObject({ status: 'ready', sourceKey: current.url, frames: [{ timestampSeconds: 2 }] });
    late.resolve();
    await closed.promise;
    expect(await oldOutcome).toHaveProperty('name', 'AbortError');
    expectReleased(old);
    expectReleased(current);
  });
});

describe('readBrowserVideoFrameTable shared HTTP boundary', () => {
  it('preserves range requests and the Response, passing the library signal through HTTP options', async () => {
    const item = fixture();
    const libraryRequest = new AbortController();
    const response = new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Range': 'bytes 0-2/100' } });
    boundary.httpRequest.mockResolvedValue(response);
    let received: Response | undefined;
    item.input.getPrimaryVideoTrack.mockImplementation(async () => {
      received = await fetchFor(item)(item.url, {
        method: 'GET', headers: { Range: 'bytes=0-2', 'X-Media-Probe': 'source' },
        credentials: 'omit', cache: 'no-store', signal: libraryRequest.signal,
      });
      return item.track;
    });
    await read(item);
    expect(received).toBe(response);
    expect(boundary.httpRequest).toHaveBeenCalledTimes(1);
    const [url, init, options] = boundary.httpRequest.mock.calls[0] as [string, RequestInit, { replaySafe: boolean; signal?: AbortSignal }];
    expect(url).toBe(item.url);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });
    expect(new Headers(init.headers).get('Range')).toBe('bytes=0-2');
    expect(new Headers(init.headers).get('X-Media-Probe')).toBe('source');
    expect(options).toMatchObject({ replaySafe: true, signal: libraryRequest.signal });
    expectReleased(item);
  });

  it.each(['metadata', 'decode'] as const)('preserves a network failure across the %s phase', async (phase) => {
    const item = fixture();
    const cause = new TypeError('Connection closed');
    boundary.httpRequest.mockRejectedValue(cause);
    if (phase === 'metadata') {
      item.input.getPrimaryVideoTrack.mockImplementation(async () => {
        await fetchFor(item)(item.url, { headers: { Range: 'bytes=0-' } });
        return item.track;
      });
    } else {
      item.sink.samples.mockImplementation(async function* (): AsyncGenerator<MockSample, void, unknown> {
        yield item.samples[0];
        await fetchFor(item)(item.url, { headers: { Range: 'bytes=100-' } });
      });
    }
    expectReadError(await observe(read(item)), 'network', cause);
    expectReleased(item, phase === 'decode' ? item.samples.slice(0, 1) : []);
  });

  it('keeps abort distinct from a failing in-flight HTTP request', async () => {
    const item = fixture();
    const entered = deferred<void>();
    const blocked = deferred<never>();
    const libraryRequest = new AbortController();
    item.onDispose = () => {
      libraryRequest.abort();
      blocked.reject(new InputDisposedError());
    };
    boundary.httpRequest.mockImplementation(() => { entered.resolve(); return blocked.promise; });
    item.input.getPrimaryVideoTrack.mockImplementation(async () => {
      await fetchFor(item)(item.url, { signal: libraryRequest.signal });
      return item.track;
    });
    const controller = new AbortController();
    const outcome = observe(read(item, controller.signal));
    await entered.promise;
    controller.abort();
    expect(await outcome).toHaveProperty('name', 'AbortError');
    expect(libraryRequest.signal.aborted).toBe(true);
    expectReleased(item, []);
  });
});
