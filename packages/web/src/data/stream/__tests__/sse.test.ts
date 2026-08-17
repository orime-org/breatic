// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The two streaming endpoints have to carry and honour the user's language
 * like every other request — and they do not go through axios to get it.
 *
 * `POST /chat/message` and `POST /mini-tools/text` both validate their body,
 * so both can answer with our error envelope. But this wrapper calls
 * `fetchEventSource`, which has its own headers (no `Accept-Language`) and
 * its own idea of what a non-stream response means: the library's
 * `defaultOnOpen` looks at `content-type`, throws a hardcoded English Error
 * when it is not `text/event-stream`, and never reads a byte of the body. A
 * localised envelope produced by the server was being thrown away unread.
 *
 * @see packages/web/src/data/stream/sse.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLocale } from '@breatic/shared';

const fetchEventSourceMock = vi.hoisted(() => vi.fn());
vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: fetchEventSourceMock,
}));

import { sseStream, StreamDroppedError, StreamRefusedError } from '@web/data/stream/sse';
import { API_BASE_PATH } from '@web/data/api/base-path';

/** The option object `sseStream` handed to the library on the last call. */
interface CapturedOptions {
  headers?: Record<string, string>;
  onopen?: (response: Response) => Promise<void> | void;
}

/**
 * Run `sseStream` once and return what it passed to `fetchEventSource`.
 * @returns The captured option object.
 */
async function optionsPassed(): Promise<CapturedOptions> {
  await sseStream({
    url: '/chat/message',
    body: { message: 'hi' },
    parseEvent: (d) => d,
    onEvent: () => undefined,
  });
  const call = fetchEventSourceMock.mock.calls.at(-1);
  return (call?.[1] ?? {}) as CapturedOptions;
}

/**
 * Build a response the way the server answers a rejected body.
 * @param body - JSON body to carry.
 * @param status - HTTP status.
 * @returns A Response with our envelope and a JSON content-type.
 */
function envelopeResponse(body: unknown, status = 422): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchEventSourceMock.mockReset();
  fetchEventSourceMock.mockResolvedValue(undefined);
});

afterEach(() => {
  setLocale('en');
});

describe('where a streaming request is sent', () => {
  it('puts a relative path under the one API prefix', async () => {
    await sseStream({
      url: '/chat/message',
      parseEvent: (d) => d,
      onEvent: () => undefined,
    });
    expect(fetchEventSourceMock.mock.calls.at(-1)?.[0]).toBe(
      `${API_BASE_PATH}/chat/message`,
    );
  });

  it('leaves an absolute URL exactly as given', async () => {
    await sseStream({
      url: 'https://example.test/stream',
      parseEvent: (d) => d,
      onEvent: () => undefined,
    });
    expect(fetchEventSourceMock.mock.calls.at(-1)?.[0]).toBe(
      'https://example.test/stream',
    );
  });
});

describe('a streaming request carries the language the user chose', () => {
  it('sends Accept-Language, which axios does for every other request', async () => {
    setLocale('zh-CN');
    const opts = await optionsPassed();
    expect(opts.headers?.['Accept-Language']).toBe('zh-CN');
  });

  it('follows the user to a different language', async () => {
    setLocale('ja');
    expect((await optionsPassed()).headers?.['Accept-Language']).toBe('ja');
    setLocale('ko');
    expect((await optionsPassed()).headers?.['Accept-Language']).toBe('ko');
  });

  it('still sends the headers it always sent', async () => {
    const opts = await optionsPassed();
    expect(opts.headers?.['Content-Type']).toBe('application/json');
  });
});

describe('when the server answers with an envelope instead of a stream', () => {
  it('reads our message out of the body', async () => {
    const opts = await optionsPassed();
    expect(opts.onopen).toBeTypeOf('function');
    await expect(
      opts.onopen?.(
        envelopeResponse({ error: { code: 422, message: '输入数据无效' } }),
      ),
    ).rejects.toThrow('输入数据无效');
  });

  it('does not surface the library\'s hardcoded English', async () => {
    const opts = await optionsPassed();
    let thrown: Error | null = null;
    try {
      await opts.onopen?.(
        envelopeResponse({
          error: { code: 422, message: '입력값이 유효하지 않습니다' },
        }),
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).not.toContain('Expected content-type');
    expect(thrown?.message).toBe('입력값이 유효하지 않습니다');
  });

  it('accepts a real stream without complaint', async () => {
    const opts = await optionsPassed();
    const streamResponse = new Response('', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    await expect(opts.onopen?.(streamResponse)).resolves.toBeUndefined();
  });

  it('still fails when the body is not our envelope at all', async () => {
    // A proxy or gateway can answer with plain text. There is nothing to read
    // out of it, but the stream still did not open, so this must not resolve.
    const opts = await optionsPassed();
    const plain = new Response('502 Bad Gateway', {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    });
    await expect(opts.onopen?.(plain)).rejects.toThrow();
  });

  it('does not hang when the body is unreadable', async () => {
    const opts = await optionsPassed();
    const broken = new Response('{ not json', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    await expect(opts.onopen?.(broken)).rejects.toThrow();
  });

  /**
   * Whoever shows this refusal has to know whether the sentence in it was
   * written for the reader. Ours was: it came out of our envelope, through
   * `t()`, in their language. The generic one below is this file's own
   * fallback -- it exists so the refusal has something to carry, not because
   * anybody wrote it about this reader's request. Passed off as the server's
   * answer it becomes a sentence our server never said.
   * @param response - What the server answered with.
   * @returns The refusal it produced.
   */
  async function refusalFrom(response: Response): Promise<StreamRefusedError> {
    const opts = await optionsPassed();
    try {
      await opts.onopen?.(response);
    } catch (err) {
      return err as StreamRefusedError;
    }
    throw new Error('it opened, which is not what this case is about');
  }

  it('says the sentence is ours when it came out of our envelope', async () => {
    const refusal = await refusalFrom(
      envelopeResponse({ error: { code: 402, message: '积分不足' } }, 402),
    );
    expect(refusal.message).toBe('积分不足');
    expect(refusal.fromServer).toBe(true);
  });

  it('says the sentence is not ours when a gateway answered', async () => {
    const refusal = await refusalFrom(
      new Response('502 Bad Gateway', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(refusal.fromServer).toBe(false);
  });

  it('says the sentence is not ours when the body is our shape but has no message', async () => {
    // A proxy that answers JSON, or one of ours that failed before it had
    // anything to say. The shape parses; there is still no sentence in it.
    const refusal = await refusalFrom(envelopeResponse({ error: { code: 500 } }, 500));
    expect(refusal.fromServer).toBe(false);
  });
});

describe('when a stream that had opened dies', () => {
  it('says so once, not once per layer that noticed', async () => {
    const onError = vi.fn();
    fetchEventSourceMock.mockImplementation(
      async (_url: string, opts: {
        onopen: (r: Response) => Promise<void>;
        onerror: (e: unknown) => void;
      }) => {
        await opts.onopen(
          new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
        // What the library does when the socket dies: hand the failure to the
        // handler, and let whatever that handler throws come back out.
        opts.onerror(new Error('socket died'));
      },
    );

    await sseStream({
      url: '/chat/message',
      parseEvent: (d) => d,
      onEvent: () => undefined,
      onError,
    });

    // One failure is one thing that happened. Told twice, a caller that acts
    // on it -- marking the reply, ending the turn, announcing it -- does all
    // of that twice, and the second time it is acting on a turn that has
    // already ended.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(StreamDroppedError);
  });
});
