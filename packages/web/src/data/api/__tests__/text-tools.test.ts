// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The text mini-tool client (inner#1860, design §5.1): the request body the
 * server's new contract reads, the frames it streams back (`text_delta`
 * carries JSON `{"text": ...}` so a newline no longer breaks the frame), a
 * stream that closes with neither `done` nor `error` reported as a failure
 * (E14), and the budgets read from `GET /mini-tools/text/config`.
 *
 * The transport underneath is replaced at the library, the way `sse.test.ts`
 * does it, so the client's own parsing and the wrapper between run for real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchEventSourceMock = vi.hoisted(() => vi.fn());
vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource: fetchEventSourceMock }));
const checkStaleRelease = vi.hoisted(() => vi.fn((_reason: unknown) => Promise.resolve(false)));
vi.mock('@web/data/deployment/stale-release', () => ({ checkStaleRelease }));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/request', () => ({ apiGet }));

import { textToolsApi, type TextStreamEvent } from '@web/data/api/text-tools';

/** What the library is handed, as far as these cases drive it. */
interface LibraryOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  onopen?: (response: Response) => Promise<void> | void;
  onmessage?: (message: { event: string; data: string; id: string }) => void;
  onclose?: () => void;
}

/** A response that opens a stream. */
function streamOpened(): Response {
  return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Plays a stream: opens it, sends the frames, then closes it cleanly.
 * @param frames - The frames, as the server writes them.
 */
function serverSends(frames: ReadonlyArray<{ event: string; data: string }>): void {
  fetchEventSourceMock.mockImplementation(async (_url: string, options: LibraryOptions) => {
    await options.onopen?.(streamOpened());
    for (const frame of frames) options.onmessage?.({ ...frame, id: '' });
    options.onclose?.();
  });
}

/**
 * Runs one request and collects what the caller hears.
 * @returns The events and the errors.
 */
async function runPolish(): Promise<{ events: TextStreamEvent[]; errors: unknown[] }> {
  const events: TextStreamEvent[] = [];
  const errors: unknown[] = [];
  await textToolsApi.stream(
    { tool: 'polish', project_id: 'p-1', selection: 'Hello', document: 'Hello world' },
    { onEvent: (event) => events.push(event), onError: (err) => errors.push(err) },
  );
  return { events, errors };
}

/** The options the library was last handed. */
function lastOptions(): LibraryOptions {
  return (fetchEventSourceMock.mock.calls.at(-1)?.[1] ?? {}) as LibraryOptions;
}

beforeEach(() => {
  fetchEventSourceMock.mockReset();
  fetchEventSourceMock.mockResolvedValue(undefined);
  apiGet.mockReset();
});

describe('the request', () => {
  it.each([
    [{ tool: 'polish', project_id: 'p-1', selection: 'Hello', document: 'Hello world' }],
    [{ tool: 'expand', project_id: 'p-1', selection: 'Hello', document: 'Hello world' }],
    [{ tool: 'shorten', project_id: 'p-1', selection: 'Hello', document: 'Hello world' }],
    [{ tool: 'translate', project_id: 'p-1', selection: 'Hello', document: 'Hello world', language: 'ja' }],
    [{ tool: 'rewrite', project_id: 'p-1', selection: 'Hello', document: 'Hello world', style: 'professional' }],
    [{ tool: 'custom', project_id: 'p-1', selection: 'Hello', document: 'Hello world', instructions: 'Make it rhyme' }],
  ] as const)('posts %j to the text tool as it is', async (body) => {
    await textToolsApi.stream(body, { onEvent: () => undefined });

    const [url] = fetchEventSourceMock.mock.calls.at(-1) as [string];
    expect(url.endsWith('/mini-tools/text')).toBe(true);
    expect(lastOptions().method).toBe('POST');
    expect(JSON.parse(lastOptions().body ?? 'null')).toEqual(body);
  });

  it('sends no Idempotency-Key: each run is its own, charged on its own', async () => {
    await textToolsApi.stream(
      { tool: 'polish', project_id: 'p-1', selection: 'Hello', document: 'Hello world' },
      { onEvent: () => undefined },
    );

    const names = Object.keys(lastOptions().headers ?? {}).map((name) => name.toLowerCase());
    expect(names).not.toContain('idempotency-key');
  });

  it('hands the caller\'s signal to the transport, so closing the dialog aborts the fetch', async () => {
    const abort = new AbortController();
    await textToolsApi.stream(
      { tool: 'polish', project_id: 'p-1', selection: 'Hello', document: 'Hello world' },
      { onEvent: () => undefined, signal: abort.signal },
    );

    expect(lastOptions().signal).toBe(abort.signal);
  });
});

describe('the frames', () => {
  it('reads text_delta as JSON, newlines and all', async () => {
    serverSends([
      { event: 'text_delta', data: JSON.stringify({ text: 'line one\nline two' }) },
      { event: 'text_delta', data: JSON.stringify({ text: '\n\n- item' }) },
      { event: 'done', data: JSON.stringify({ type: 'done', tokens: 12, creditsUsed: '0.1' }) },
    ]);

    const { events, errors } = await runPolish();

    expect(events.slice(0, 2)).toEqual([
      { type: 'text_delta', text: 'line one\nline two' },
      { type: 'text_delta', text: '\n\n- item' },
    ]);
    expect(events[2]).toMatchObject({ type: 'done' });
    expect(events).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it('passes an error event on with the server\'s message, and reports no second failure when the stream then closes', async () => {
    serverSends([
      { event: 'text_delta', data: JSON.stringify({ text: 'Hel' }) },
      { event: 'error', data: JSON.stringify({ type: 'error', message: 'The model is unavailable.' }) },
    ]);

    const { events, errors } = await runPolish();

    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'The model is unavailable.' });
    expect(errors).toEqual([]);
  });

  it('reports a stream that closes with neither done nor error as a failure (E14)', async () => {
    serverSends([{ event: 'text_delta', data: JSON.stringify({ text: 'Hel' }) }]);

    const { events, errors } = await runPolish();

    expect(events).toEqual([{ type: 'text_delta', text: 'Hel' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('reports an empty stream that just closes as a failure too', async () => {
    serverSends([]);

    const { errors } = await runPolish();

    expect(errors).toHaveLength(1);
  });

  it('reads a frame it does not know as nothing, so the stream closing after it is one failure', async () => {
    serverSends([{ event: 'aborted', data: JSON.stringify({ type: 'aborted' }) }]);

    const { events, errors } = await runPolish();

    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('reports nothing more after done', async () => {
    serverSends([{ event: 'done', data: JSON.stringify({ type: 'done', tokens: 1, creditsUsed: '0' }) }]);

    const { errors } = await runPolish();

    expect(errors).toEqual([]);
  });
});

describe('the budgets', () => {
  it('reads them from GET /mini-tools/text/config', async () => {
    apiGet.mockResolvedValue({ selectionMaxChars: 4000, contextMaxChars: 20000 });

    const config = await textToolsApi.config();

    expect(apiGet.mock.calls[0]?.[0]).toBe('/mini-tools/text/config');
    expect(config).toEqual({ selectionMaxChars: 4000, contextMaxChars: 20000 });
  });
});
