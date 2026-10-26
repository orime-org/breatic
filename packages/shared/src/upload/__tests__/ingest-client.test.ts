// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending bytes to the ingest Worker (#173 design §4.2, #181 lane ②, #206
 * design §3.5).
 *
 * Two steps here: open the upload for a session token, then PUT each part and
 * take the fresh token it answers with. Since the token rotates per part, what
 * has to be shown is that part n carries the token part n-1 handed back.
 *
 * Finishing is a third step, and it belongs to whoever drives it. The browser
 * hands what it holds to our server, which finishes on its behalf; our own
 * worker finishes for itself. Both go through the same call, and both present
 * the shared secret the Worker asks for — which is what keeps a page from
 * finishing an upload behind our back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpRequest } from '@shared/http/request.js';
import { decideRetry } from '@shared/http/decide-retry.js';
import { MAX_TIMER_MS } from '@shared/http/constants.js';
import { DeadlinePassed } from '@shared/http/deadline.js';
import { INGEST_FAILURE_HEADER } from '@shared/upload/ingest-failure.js';
import {
  sendBytesToIngest,
  finishUploadAtIngest,
  fetchUrlToIngest,
  readStoredMediaAtIngest,
  IngestAnswerError,
  type IngestTarget,
  type UploadClientConfig,
} from '@shared/upload/ingest-client.js';

vi.mock('@shared/http/request.js', () => ({ httpRequest: vi.fn() }));

const mockedRequest = vi.mocked(httpRequest);

const PART_SIZE = 5 * 1024 * 1024;
const SECRET = 'shared-secret';
const COVER_KEY = "video/2026-09-15/1_clip_cover.png";
const WORKER_URL = 'https://ingest.example.com';

const cfg: UploadClientConfig = {
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 500,
  uploadIdleTimeoutMs: 60_000,
};

/** A ticket for a file of `totalParts` parts. */
function ticketFor(totalParts: number): IngestTarget {
  return {
    ticket: 'signed-ticket',
    uploadUrl: WORKER_URL,
    partSize: PART_SIZE,
    totalParts,
  };
}

/** A file of `bytes` bytes. */
function fileOf(bytes: number): File {
  return new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' });
}

/** An answer with `body` as its JSON, and the failure it named if any. */
function answers(status: number, body: unknown, failure?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: {
      get: (name: string) =>
        name === INGEST_FAILURE_HEADER ? (failure ?? null) : null,
    },
  } as unknown as Response;
}

/** The url of the nth call. */
function urlOf(nth: number): string {
  return String(mockedRequest.mock.calls[nth]?.[0]);
}

/** The headers of the nth call. */
function headersOf(nth: number): Record<string, string> {
  const init = mockedRequest.mock.calls[nth]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

/** The transport options of the nth call. */
function optionsOf(nth: number): {
  replaySafe: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
} {
  const options = mockedRequest.mock.calls[nth]?.[2];
  if (options === undefined) throw new Error(`no call ${nth}`);
  return options;
}

beforeEach(() => {
  mockedRequest.mockReset();
});

/** Answer an open and `parts` part PUTs. */
function wireOpenAndParts(parts: number): void {
  mockedRequest.mockResolvedValueOnce(
    answers(200, { uploadId: 'upload-1', token: 'token-0' }),
  );
  for (let n = 1; n <= parts; n += 1) {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { token: `token-${n}`, partNumber: n, etag: `etag-${n}` }),
    );
  }
}

/** What the Worker measures over an object that landed. */
const MEASURED = {
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  contentType: 'image/png',
};

/** When the upload's task runs out, as the caller worked it out. */
const DEADLINE_AT = 1_800_000_000_000;

/** What the Worker turns a tagged picture upright under (inner#1367). */
const LIMITS = { uprightJpegQuality: 90, uprightMaxBytes: 2 * 1024 * 1024 * 1024 };

describe('sending bytes to the ingest Worker', () => {
  it('opens the upload with the ticket our server signed', async () => {
    wireOpenAndParts(1);

    await sendBytesToIngest(fileOf(1024), ticketFor(1), cfg);

    expect(urlOf(0)).toBe('https://ingest.example.com/uploads');
    expect(headersOf(0)['x-upload-ticket']).toBe('signed-ticket');
  });

  it('reports the bytes landed after each part, so a page can show progress', async () => {
    wireOpenAndParts(3);
    const landed: number[] = [];

    await sendBytesToIngest(fileOf(PART_SIZE * 2 + 700), ticketFor(3), cfg, (bytes) => {
      landed.push(bytes);
    });

    expect(landed).toEqual([PART_SIZE, PART_SIZE * 2, PART_SIZE * 2 + 700]);
  });

  it('cuts at the signed part size, and only the last part may be short', async () => {
    wireOpenAndParts(3);

    await sendBytesToIngest(fileOf(PART_SIZE * 2 + 700), ticketFor(3), cfg);

    const sizes = [1, 2, 3].map((n) => {
      const init = mockedRequest.mock.calls[n]?.[1];
      return (init?.body as Blob).size;
    });
    expect(sizes).toEqual([PART_SIZE, PART_SIZE, 700]);
  });

  it('sends each part to the address for its own part number', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(urlOf(1)).toBe('https://ingest.example.com/uploads/upload-1/parts/1');
    expect(urlOf(2)).toBe('https://ingest.example.com/uploads/upload-1/parts/2');
  });

  // The token rotates per part, so a leaked one can only write the next part
  // of this one upload.
  it('carries the token the previous part handed back', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(headersOf(1)['x-upload-token']).toBe('token-0');
    expect(headersOf(2)['x-upload-token']).toBe('token-1');
  });

  // Nothing on the Worker's side remembers which parts landed, so what
  // finishes an upload is the list this side built up (design §6.1). Handing
  // it back rather than using it here is what lets our server finish for the
  // browser, which cannot hold the secret the Worker asks for.
  it('hands back what finishing this upload will need', async () => {
    wireOpenAndParts(3);

    const held = await sendBytesToIngest(
      fileOf(PART_SIZE * 2 + 700),
      ticketFor(3),
      cfg,
    );

    expect(held).toEqual({
      uploadId: 'upload-1',
      token: 'token-3',
      parts: [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 3, etag: 'etag-3' },
      ],
    });
  });

  it('stops once the last part has landed', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    // One open and two parts. A third delivery here would be a finish this
    // caller may not be able to authorise.
    expect(mockedRequest).toHaveBeenCalledTimes(3);
  });
});

describe('finishing an upload', () => {
  const held = {
    uploadId: 'upload-1',
    token: 'token-3',
    parts: [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
    ],
  };

  it('asks the upload it holds to finish, with the newest token', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(WORKER_URL, held, SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS });

    expect(urlOf(0)).toBe(
      'https://ingest.example.com/uploads/upload-1/complete',
    );
    expect(headersOf(0)['x-upload-token']).toBe('token-3');
  });

  // A ticket and a session token both travel to the browser. The secret is the
  // one thing only our own servers hold, and finishing is the step whose
  // permission lives in our ledger rather than in the token.
  it('presents the shared secret', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(WORKER_URL, held, SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS });

    expect(headersOf(0)['x-ingest-secret']).toBe(SECRET);
  });

  it('hands back every part receipt, as JSON it says is JSON', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(WORKER_URL, held, SECRET, {
      coverKey: COVER_KEY,
      deadlineAt: DEADLINE_AT, limits: LIMITS,
    });

    expect(headersOf(0)['content-type']).toBe('application/json');
    expect(JSON.parse(mockedRequest.mock.calls[0]?.[1]?.body as string)).toEqual({
      parts: held.parts,
      // The Worker holds the media container to the task's own deadline.
      deadlineAt: DEADLINE_AT, limits: LIMITS,
      // Named on every finish. Which media have a frame to lift is decided
      // from the type, and the type is the edge's to read off the bytes — so
      // no caller knows yet whether this key will be written to.
      coverKey: COVER_KEY,
    });
  });

  // A cover or an avatar is read after the upload returns (#299). The request
  // still carries the deadline: what says "not now" is its own field.
  it('asks for no media read when the caller defers it', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await finishUploadAtIngest(WORKER_URL, held, SECRET, {
      coverKey: COVER_KEY,
      deadlineAt: DEADLINE_AT, limits: LIMITS,
      deferMediaRead: true,
    });

    expect(JSON.parse(mockedRequest.mock.calls[0]?.[1]?.body as string)).toEqual({
      parts: held.parts,
      deadlineAt: DEADLINE_AT, limits: LIMITS,
      coverKey: COVER_KEY,
      deferMediaRead: true,
    });
  });

  it('answers with what the Worker measured over the stored object', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    const measured = await finishUploadAtIngest(WORKER_URL, held, SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS });

    // A medium with no such number and an answer that never carried the field
    // are the same fact, so both read as none and every caller has one case.
    expect(measured).toEqual({
      ...MEASURED,
      width: null,
      height: null,
      durationSeconds: null,
      cover: null,
      upright: null,
    });
  });

  // The three numbers decide whether a node shows a resolution and a poster,
  // never whether the upload succeeded. So an answer this side cannot use
  // comes back as no such number, on every lane — the caller files what it was
  // given, and a value the column cannot hold would fail an upload whose bytes
  // are already stored and hashed.
  it.each([
    // `duration_seconds` is numeric(12,3), and its rule is about the value
    // AFTER rounding to three places — measured against the real database,
    // 999999999.9995 overflows and 999999999.99949 does not.
    ['a duration past what the column holds', { durationSeconds: 1_000_000_000 }],
    ['a duration the column rounds past its limit', { durationSeconds: 999_999_999.9995 }],
    ['a negative dimension', { width: -5 }],
    ['a fractional dimension', { height: 1.5 }],
    ['a dimension past what the column holds', { width: 2_147_483_648 }],
    ['a duration of zero', { durationSeconds: 0 }],
    ['a dimension that is not a number', { width: 'wide' }],
  ])('answers no number for %s', async (_case, odd) => {
    mockedRequest.mockResolvedValueOnce(answers(200, { ...MEASURED, ...odd }));

    const measured = await finishUploadAtIngest(
      WORKER_URL,
      held,
      SECRET,
      { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS },
    );

    expect(measured).toMatchObject({ width: null, height: null, durationSeconds: null });
  });

  // A cover is its own asset row, so a half-described one cannot be filed.
  // A picture with an EXIF orientation is registered as its upright copy,
  // stored beside it (inner#1367).
  it('reads the upright copy the Worker wrote for a tagged picture', async () => {
    const upright = { storageKey: 'image/2026-10-10/1_x_upright.jpg', sizeBytes: 900, width: 3000, height: 4000 };
    mockedRequest.mockResolvedValueOnce(answers(200, { ...MEASURED, upright }));

    const measured = await finishUploadAtIngest(WORKER_URL, held, SECRET, {
      coverKey: COVER_KEY,
      deadlineAt: DEADLINE_AT,
      limits: LIMITS,
    });

    expect(measured.upright).toEqual(upright);
  });

  // Filing the original in its place would put a sideways picture on the node,
  // so an upright copy that cannot be read makes the answer unusable.
  it('refuses an answer whose upright copy cannot be read', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { ...MEASURED, upright: { storageKey: '', sizeBytes: -1 } }),
    );

    await expect(
      finishUploadAtIngest(WORKER_URL, held, SECRET, {
        coverKey: COVER_KEY,
        deadlineAt: DEADLINE_AT,
        limits: LIMITS,
      }),
    ).rejects.toBeInstanceOf(IngestAnswerError);
  });

  it('answers no cover when the one described is missing a field', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, {
        ...MEASURED,
        cover: { storageKey: 'video/k_cover.png', sizeBytes: 10 },
      }),
    );

    const measured = await finishUploadAtIngest(
      WORKER_URL,
      held,
      SECRET,
      { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS },
    );

    expect(measured.cover).toBeNull();
  });

  it.each([
    ['an ordinary running time', 12.25],
    ['the largest the column takes, which rounds just under', 999_999_999.99949],
  ])('keeps %s', async (_case, durationSeconds) => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { ...MEASURED, width: 1920, height: 1080, durationSeconds }),
    );

    const measured = await finishUploadAtIngest(
      WORKER_URL,
      held,
      SECRET,
      { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS },
    );

    expect(measured).toMatchObject({ width: 1920, height: 1080, durationSeconds });
  });

  // These three decide whether the upload succeeded at all, so an answer
  // missing one of them is unusable rather than degraded.
  it('fails when the answer carries no hash', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { sizeBytes: 1024, contentType: 'image/png' }),
    );

    await expect(
      finishUploadAtIngest(WORKER_URL, held, SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS }),
    ).rejects.toThrow();
  });

  // 409 means parts are missing: this upload will never become the object it
  // was opened for.
  it('fails when the Worker says the upload never completed', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(409, { reason: 'only 0 of 1 parts arrived' }),
    );

    await expect(
      finishUploadAtIngest(WORKER_URL, held, SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS }),
    ).rejects.toThrow();
  });
});

// What the transport is told decides how many times a request is delivered and
// when one is given up on. Neither is visible in the response, so it is stated
// here or nowhere.
describe('what the shared transport is told', () => {
  // The test is whether a request names the upload it writes into. A part and
  // a completion do, so a repeat writes the same part under its own number or
  // is answered out of the ledger. Opening carries no id: it mints one, and
  // the Worker opens a fresh multipart upload on every delivery, so a replay
  // abandons the first one holding parts R2 charges for.
  it('declares opening unsafe to replay, and the parts safe', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(optionsOf(0).replaySafe).toBe(false);
    expect(optionsOf(1).replaySafe).toBe(true);
    expect(optionsOf(2).replaySafe).toBe(true);
  });

  // What a part gets when the Worker cannot store it is decided by two facts
  // held in different packages: the status the Worker answers with (5xx, held
  // in `packages/ingest/src/__tests__/upload-part.test.ts`) and what this side
  // declared about replaying a part. Neither one alone says whether the part
  // is sent again, so the pairing is stated here, against the declaration the
  // call above actually made.
  //
  // 410 is the answer the Worker used to give (#206 §4): a status this rule
  // never repeats, which turned one failed part into a failed upload.
  it('sends a part again when the Worker fails it, and never on a 410', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);
    const partIsReplaySafe = optionsOf(1).replaySafe;

    expect(
      decideRetry({ status: 502, replaySafe: partIsReplaySafe, attempt: 1 })
        .retry,
    ).toBe(true);
    expect(
      decideRetry({ status: 410, replaySafe: partIsReplaySafe, attempt: 1 })
        .retry,
    ).toBe(false);
  });

  // A part is cut only once its bytes stop moving (inner#1367), however long
  // a slow part that keeps moving takes. In a page the transport judges that
  // from upload progress.
  // A page holds no deadline; the Worker refuses a part past the upload's own,
  // so no total of ours is set and the transport's default never cuts a part.
  it('times each part by the idle window, with no total of its own', async () => {
    wireOpenAndParts(2);

    await sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg);

    expect(optionsOf(1).idleTimeoutMs).toBe(cfg.uploadIdleTimeoutMs);
    expect(optionsOf(2).idleTimeoutMs).toBe(cfg.uploadIdleTimeoutMs);
    expect(optionsOf(1).timeoutMs).toBe(MAX_TIMER_MS);
    expect(optionsOf(2).timeoutMs).toBe(MAX_TIMER_MS);
  });

  // Node judges the same on the socket: the caller hands in a dispatcher that
  // times it, and the transport is given no idle window it cannot honour.
  it('sends parts through the dispatcher a backend caller hands in', async () => {
    wireOpenAndParts(1);
    const dispatcher = { name: 'idle-socket' };

    await sendBytesToIngest(fileOf(10), { ...ticketFor(1), dispatcher }, cfg);

    const init = mockedRequest.mock.calls[1]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBe(dispatcher);
    expect(optionsOf(1).idleTimeoutMs).toBeUndefined();
  });

  // Every call on an upload is bounded by its task's deadline: the signal ends
  // it and its resends there, and each delivery may run until then, so the
  // transport's own default never cuts it sooner (inner#1367 §4.8c).
  it('bounds every call of a backend upload by its deadline', async () => {
    wireOpenAndParts(1);
    const deadlineAt = Date.now() + 7_200_000;

    await sendBytesToIngest(fileOf(10), { ...ticketFor(1), dispatcher: {} }, cfg, undefined, deadlineAt);

    for (const nth of [0, 1]) {
      expect(optionsOf(nth).signal).toBeInstanceOf(AbortSignal);
      expect(optionsOf(nth).timeoutMs).toBeGreaterThan(7_190_000);
      expect(optionsOf(nth).timeoutMs).toBeLessThanOrEqual(7_200_000);
    }
  });

  it('bounds finishing by its deadline, and repeats it', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));
    const deadlineAt = Date.now() + 7_200_000;

    await finishUploadAtIngest(
      WORKER_URL,
      { uploadId: 'upload-1', token: 'token-3', parts: [] },
      SECRET,
      { coverKey: COVER_KEY, deadlineAt, limits: LIMITS },
    );

    expect(optionsOf(0).replaySafe).toBe(true);
    expect(optionsOf(0).signal).toBeInstanceOf(AbortSignal);
    expect(optionsOf(0).timeoutMs).toBeGreaterThan(7_190_000);
  });

  it('sends nothing once the deadline has come', async () => {
    await expect(
      finishUploadAtIngest(
        WORKER_URL,
        { uploadId: 'upload-1', token: 'token-3', parts: [] },
        SECRET,
        { coverKey: COVER_KEY, deadlineAt: Date.now() - 1, limits: LIMITS },
      ),
    ).rejects.toBeInstanceOf(DeadlinePassed);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});

// Lane 3: the bytes are at a provider's link and never reach this process. The
// Worker fetches them where R2 already is, so what travels is the address and
// the ticket that says where they may land.
describe('handing the Worker a URL to fetch', () => {
  const SOURCE = 'https://provider.example/generated/clip.mp4';

  it('names the fetch endpoint and carries the ticket and the secret', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await fetchUrlToIngest(SOURCE, ticketFor(1), SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS });

    expect(urlOf(0)).toBe(`${WORKER_URL}/fetch`);
    expect(headersOf(0)).toMatchObject({
      'x-upload-ticket': 'signed-ticket',
      'x-ingest-secret': SECRET,
    });
  });

  it('sends the address, the cover key and the container deadlines', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await fetchUrlToIngest(
      SOURCE,
      ticketFor(1),
      SECRET,
      { coverKey: 'video/2026-09-11/1_clip_cover.png', deadlineAt: DEADLINE_AT, limits: LIMITS },
    );

    expect(JSON.parse(String(mockedRequest.mock.calls[0]?.[1]?.body))).toEqual({
      url: SOURCE,
      coverKey: 'video/2026-09-11/1_clip_cover.png',
      // The Worker holds the transfer and the container to the task's own
      // deadline.
      deadlineAt: DEADLINE_AT, limits: LIMITS,
    });
  });

  // Sending this again is a second full transfer: the Worker opens its own
  // multipart upload each time it runs, so a repeat re-fetches the source and
  // writes R2 a second time.
  it('tells the transport that sending it again costs something', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));

    await fetchUrlToIngest(SOURCE, ticketFor(1), SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS });

    expect(optionsOf(0).replaySafe).toBe(false);
  });

  // A caller with a reader watching (the agent's save, inner#1315) stops the
  // transfer when the reader stops the turn, besides the deadline.
  it("stops the transfer when the caller's signal is raised", async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));
    const stop = new AbortController();

    await fetchUrlToIngest(
      SOURCE,
      ticketFor(1),
      SECRET,
      { coverKey: COVER_KEY, deadlineAt: Date.now() + 7_200_000, limits: LIMITS },
      stop.signal,
    );

    expect(optionsOf(0).signal?.aborted).toBe(false);
    stop.abort();
    expect(optionsOf(0).signal?.aborted).toBe(true);
  });

  it('waits until the deadline and no shorter', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, MEASURED));
    const deadlineAt = Date.now() + 7_200_000;

    await fetchUrlToIngest(SOURCE, ticketFor(1), SECRET, { coverKey: COVER_KEY, deadlineAt, limits: LIMITS });

    expect(optionsOf(0).signal).toBeInstanceOf(AbortSignal);
    expect(optionsOf(0).timeoutMs).toBeGreaterThan(7_190_000);
  });

  it('reads the same measurements a finish is read for', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, {
        ...MEASURED,
        width: '1920',
        height: '1080',
        durationSeconds: '12.25',
      }),
    );

    const measured = await fetchUrlToIngest(
      SOURCE,
      ticketFor(1),
      SECRET,
      { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS },
    );

    expect(measured).toMatchObject({
      width: 1920,
      height: 1080,
      durationSeconds: 12.25,
    });
  });

  it('rejects an answer the ledger cannot be written from', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, { sha256: 'not-a-hash' }));

    await expect(
      fetchUrlToIngest(SOURCE, ticketFor(1), SECRET, { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS }),
    ).rejects.toThrow();
  });
});

// The read a cover or an avatar skipped at finish, asked for afterwards by our
// worker (#299). The object already stands; this only asks what it measures.
describe('reading a stored object', () => {
  const ABOUT = {
    storageKey: 'image/2026-10-01/1_cover.jpg',
    contentType: 'image/jpeg',
    deadlineAt: DEADLINE_AT,
  };

  it('waits until the deadline and no shorter', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, { width: 800, height: 450 }));

    await readStoredMediaAtIngest(WORKER_URL, SECRET, { ...ABOUT, deadlineAt: Date.now() + 7_200_000 });

    expect(optionsOf(0).signal).toBeInstanceOf(AbortSignal);
    expect(optionsOf(0).timeoutMs).toBeGreaterThan(7_190_000);
  });

  it('names the media endpoint and presents the shared secret', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, { width: 800, height: 450 }));

    await readStoredMediaAtIngest(WORKER_URL, SECRET, ABOUT);

    expect(urlOf(0)).toBe(`${WORKER_URL}/media`);
    expect(headersOf(0)).toMatchObject({
      'x-ingest-secret': SECRET,
      'content-type': 'application/json',
    });
  });

  it('sends the key, the type the ledger recorded and the deadline', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, { width: 800, height: 450 }));

    await readStoredMediaAtIngest(WORKER_URL, SECRET, ABOUT);

    expect(JSON.parse(String(mockedRequest.mock.calls[0]?.[1]?.body))).toEqual(ABOUT);
  });

  // Reading writes nothing, so a repeat costs one more container run and
  // nothing else.
  it('tells the transport that sending it again is safe', async () => {
    mockedRequest.mockResolvedValueOnce(answers(200, { width: 800, height: 450 }));

    await readStoredMediaAtIngest(WORKER_URL, SECRET, ABOUT);

    expect(optionsOf(0).replaySafe).toBe(true);
  });

  it('answers the three numbers, each unusable one as none', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { width: '800', height: -1, durationSeconds: null }),
    );

    const read = await readStoredMediaAtIngest(WORKER_URL, SECRET, ABOUT);

    expect(read).toEqual({ width: 800, height: null, durationSeconds: null });
  });

  it('carries the status when the Worker refuses', async () => {
    mockedRequest.mockResolvedValueOnce(answers(404, {}));

    await expect(
      readStoredMediaAtIngest(WORKER_URL, SECRET, ABOUT),
    ).rejects.toMatchObject({ status: 404 });
  });

  // The deferred read of a cover or an avatar and the backfill both ask for a
  // preview (inner#1320), and the backfill needs to know what became of it.
  it('asks for a preview and answers what became of it', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { width: 800, height: 450, durationSeconds: null, preview: 'generated' }),
    );

    const read = await readStoredMediaAtIngest(WORKER_URL, SECRET, {
      ...ABOUT,
      wantPreview: true,
    });

    expect(JSON.parse(String(mockedRequest.mock.calls[0]?.[1]?.body))).toMatchObject({
      wantPreview: true,
    });
    expect(read).toEqual({
      width: 800,
      height: 450,
      durationSeconds: null,
      preview: 'generated',
    });
  });

  // The audio-peaks job asks for peaks the same way (inner#1305) and retries
  // when they came back failed.
  it('asks for peaks and answers what became of them', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { width: null, height: null, durationSeconds: 61, peaks: 'failed' }),
    );

    const read = await readStoredMediaAtIngest(WORKER_URL, SECRET, {
      ...ABOUT,
      wantPeaks: true,
    });

    expect(JSON.parse(String(mockedRequest.mock.calls[0]?.[1]?.body))).toMatchObject({
      wantPeaks: true,
    });
    expect(read).toEqual({ width: null, height: null, durationSeconds: 61, peaks: 'failed' });
  });

  it('reads a peaks outcome it does not know as none given', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { width: null, height: null, durationSeconds: 61, peaks: 'maybe' }),
    );

    const read = await readStoredMediaAtIngest(WORKER_URL, SECRET, { ...ABOUT, wantPeaks: true });

    expect(read).not.toHaveProperty('peaks');
  });

  it('reads an outcome it does not know as none given', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { width: 800, height: 450, durationSeconds: null, preview: 'maybe' }),
    );

    const read = await readStoredMediaAtIngest(WORKER_URL, SECRET, {
      ...ABOUT,
      wantPreview: true,
    });

    expect(read).not.toHaveProperty('preview');
  });
});

describe('when the Worker refuses', () => {
  it('sends no bytes when the upload cannot be opened', async () => {
    mockedRequest.mockResolvedValueOnce(answers(401, {}));

    await expect(
      sendBytesToIngest(fileOf(1024), ticketFor(1), cfg),
    ).rejects.toThrow();

    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  // Four separate failures answer 502. Telling a node that its source was
  // unreachable when our own storage would not take the bytes is a false
  // statement about somebody else's service, so the reason travels with the
  // status rather than being guessed from it.
  it('carries the reason the Worker named', async () => {
    mockedRequest.mockResolvedValueOnce(answers(502, {}, 'store_failed'));

    await expect(
      fetchUrlToIngest(
        'https://provider.example/x.mp4',
        ticketFor(1),
        SECRET,
        { coverKey: COVER_KEY, deadlineAt: DEADLINE_AT, limits: LIMITS },
      ),
    ).rejects.toMatchObject({ status: 502, code: 'store_failed' });
  });

  it('carries no reason when the answer named none', async () => {
    mockedRequest.mockResolvedValueOnce(answers(401, {}));

    await expect(
      sendBytesToIngest(fileOf(1024), ticketFor(1), cfg),
    ).rejects.toMatchObject({ status: 401, code: null });
  });

  it('stops at a refused part instead of sending the rest', async () => {
    mockedRequest.mockResolvedValueOnce(
      answers(200, { uploadId: 'upload-1', token: 'token-0' }),
    );
    mockedRequest.mockResolvedValueOnce(answers(400, {}));

    await expect(
      sendBytesToIngest(fileOf(PART_SIZE + 10), ticketFor(2), cfg),
    ).rejects.toThrow();

    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });
});

// inner#1006 §4.7 (W08): a transfer upload is cancelled when its chat turn is
// stopped, so `sendBytesToIngest` takes an optional signal, checks it between
// parts and hands it to each part request. The design names no position for
// the new parameter; it is taken here as the next positional one, after
// `deadlineAt`.
describe('W08 stopping an upload between parts', () => {
  it('throws AbortError, sends no further part, and hands the first part the signal', async () => {
    wireOpenAndParts(3);
    const stop = new AbortController();

    const sent = sendBytesToIngest(
      fileOf(PART_SIZE * 2 + 700),
      ticketFor(3),
      cfg,
      (bytes) => {
        if (bytes === PART_SIZE) stop.abort();
      },
      undefined,
      stop.signal,
    );

    await expect(sent).rejects.toMatchObject({ name: 'AbortError' });
    // The open plus the first part, and nothing after the abort.
    expect(mockedRequest).toHaveBeenCalledTimes(2);
    expect(urlOf(1)).toBe('https://ingest.example.com/uploads/upload-1/parts/1');
    expect(optionsOf(1).signal).toBe(stop.signal);
  });
});
