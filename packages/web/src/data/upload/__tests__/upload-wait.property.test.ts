// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * PT-3 (#1580 test spec §4, invariant I4): whatever order the page's upload events come in, each wait is registered
 * before any byte request of its upload, ends or is taken back at most once and never both, and after its page went
 * away no result reaches it. Two levels: the table under random waits, endings and departures, compared with a model
 * of §5.3; and one upload through the pipeline under random send, finish and message timings.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { UploadClientConfig, UploadStatus } from '@breatic/shared';
import type { UploadTicket, UploadTicketResponse } from '@web/data/upload/ingest-upload';
import { runMediaUpload } from '@web/data/upload/media-upload';
import { settleUploadEnding, waitForUploadEnding, waitingUploadKeys } from '@web/data/upload/upload-status';

let run = 0;

/**
 * An ended status for `key`.
 * @param key - The key.
 * @param kind - Which ending.
 * @returns The status.
 */
function ending(key: string, kind: 'completed' | 'failed' | 'transferred'): UploadStatus {
  if (kind === 'failed') return { key, state: 'failed', reason: 'empty' };
  if (kind === 'transferred') return { key, state: 'transferred' };
  return { key, state: 'completed', result: { assetId: `a-${key}`, fileUrl: `https://assets.example.test/${key}`, kind: 'image', width: 1, height: 1 } };
}

/** Let promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

type TableEvent =
  | { kind: 'wait'; key: number; page: number }
  | { kind: 'end'; key: number; how: 'completed' | 'failed' | 'transferred' | 'finishing' }
  | { kind: 'leave'; page: number };

const tableEvent: fc.Arbitrary<TableEvent> = fc.oneof(
  fc.record({ kind: fc.constant('wait' as const), key: fc.integer({ min: 0, max: 3 }), page: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ kind: fc.constant('end' as const), key: fc.integer({ min: 0, max: 3 }), how: fc.constantFrom('completed', 'failed', 'transferred', 'finishing') as fc.Arbitrary<'completed' | 'failed' | 'transferred' | 'finishing'> }),
  fc.record({ kind: fc.constant('leave' as const), page: fc.integer({ min: 0, max: 2 }) }),
);

describe('PT-3 the table under any order of waits, endings and departures', () => {
  it('ends each wait as the first of its ending or its page leaving, once, and nothing after', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(tableEvent, { maxLength: 40 }), async (events) => {
        run += 1;
        const keyOf = (k: number): string => `uploads/pt3-${run}-${k}.png`;
        const pages = [new AbortController(), new AbortController(), new AbortController()];
        const left = new Set<number>();
        type Wait = { key: number; page: number; expected: string | null; outcomes: string[] };
        const waits: Wait[] = [];
        for (const event of events) {
          if (event.kind === 'wait') {
            const w: Wait = { key: event.key, page: event.page, expected: left.has(event.page) ? 'abort' : null, outcomes: [] };
            waits.push(w);
            waitForUploadEnding(keyOf(event.key), pages[event.page]!.signal).then(
              (v) => w.outcomes.push(`ended:${v.state}`),
              () => w.outcomes.push('abort'),
            );
          } else if (event.kind === 'end') {
            for (const w of waits) if (w.key === event.key && w.expected === null && event.how !== 'finishing') w.expected = `ended:${event.how}`;
            settleUploadEnding(event.how === 'finishing' ? { key: keyOf(event.key), state: 'finishing' } : ending(keyOf(event.key), event.how));
          } else {
            left.add(event.page);
            for (const w of waits) if (w.page === event.page && w.expected === null) w.expected = 'abort';
            pages[event.page]!.abort();
          }
          await flush();
        }
        for (const w of waits) {
          expect(w.outcomes.length).toBeLessThanOrEqual(1);
          expect(w.outcomes[0] ?? null).toBe(w.expected);
        }
        const stillWaiting = new Set(waits.filter((w) => w.expected === null).map((w) => keyOf(w.key)));
        for (const k of [0, 1, 2, 3].map(keyOf)) expect(waitingUploadKeys().includes(k)).toBe(stillWaiting.has(k));
        for (const k of stillWaiting) settleUploadEnding(ending(k, 'failed'));
        for (const p of pages) p.abort();
        await flush();
      }),
      { numRuns: 100 },
    );
  });
});

const CONFIG: UploadClientConfig = { maxUploadBytes: 2147483648, clientMaxAttempts: 3, clientRetryBaseDelayMs: 1, uploadIdleTimeoutMs: 60000 };

describe('PT-3 one upload under any send, finish and message timing', () => {
  it('registers before the bytes, ends at most once, and takes the registration back on failure or a stop', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          send: fc.constantFrom('ok', 'fail', 'stop') as fc.Arbitrary<'ok' | 'fail' | 'stop'>,
          told: fc.constantFrom('before-send-ends', 'after-send-ends', 'twice', 'never') as fc.Arbitrary<'before-send-ends' | 'after-send-ends' | 'twice' | 'never'>,
          ended: fc.constantFrom('completed', 'failed') as fc.Arbitrary<'completed' | 'failed'>,
          leaveAfter: fc.boolean(),
        }),
        async ({ send, told, ended, leaveAfter }) => {
          run += 1;
          const key = `uploads/pt3-up-${run}.png`;
          const ticket: UploadTicket = { uploadId: `u-${run}`, token: 't', storageKey: key, uploadUrl: 'https://ingest.example.test', kind: 'image', partSize: 8388608, totalParts: 1 };
          const page = new AbortController();
          const registeredAtSend: boolean[] = [];
          let release: (v: { storageKey: string }) => void = () => undefined;
          let refuse: (e: unknown) => void = () => undefined;
          const onSuccess = vi.fn();
          const onFailure = vi.fn();
          const upload = runMediaUpload(new File(['x'], 'x.png', { type: 'image/png' }), { projectId: 'p', derived: true }, {
            getUploadConfig: async () => CONFIG,
            hashFile: async () => 'c'.repeat(64),
            requestTicket: async (): Promise<UploadTicketResponse> => ticket,
            sendToIngest: (_f, t) => {
              registeredAtSend.push(waitingUploadKeys().includes(t.storageKey));
              return new Promise((ok, fail) => {
                release = ok;
                refuse = fail;
              });
            },
            onSuccess,
            onFailure,
          }, page.signal).catch(() => undefined);
          await vi.waitFor(() => expect(registeredAtSend).toHaveLength(1));
          if (told === 'before-send-ends') settleUploadEnding(ending(key, ended));
          if (send === 'ok') release({ storageKey: key });
          else if (send === 'fail') refuse(new Error('network'));
          else {
            page.abort();
            refuse(new DOMException('aborted', 'AbortError'));
          }
          await flush();
          if (told === 'after-send-ends' || told === 'twice') settleUploadEnding(ending(key, ended));
          if (told === 'twice') settleUploadEnding(ending(key, ended === 'completed' ? 'failed' : 'completed'));
          await flush();
          if (leaveAfter) page.abort();
          if (send === 'ok' && told === 'never' && !leaveAfter) settleUploadEnding(ending(key, 'failed'));
          await upload;
          await flush();

          expect(registeredAtSend).toEqual([true]);
          expect(onSuccess.mock.calls.length + onFailure.mock.calls.length).toBeLessThanOrEqual(1);
          if (send !== 'ok') expect(onSuccess).not.toHaveBeenCalled();
          if (send === 'stop') expect(onFailure).not.toHaveBeenCalled();
          if (send === 'ok' && told !== 'never' && ended === 'completed') expect(onSuccess).toHaveBeenCalledTimes(1);
          expect(waitingUploadKeys()).not.toContain(key);
        },
      ),
      { numRuns: 100 },
    );
  });
});
