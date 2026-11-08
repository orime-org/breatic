// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 8 (inner#1790 web spec 24.1 and W8-14,
 * design 5.6 "stateless 消息的顺序", Y1, Y8): every stateless message a Space
 * provider sends leaves after the Updates already written. `SpaceProvider`
 * overrides `sendStateless` to flush its batch first, so a `doc:size-seen`
 * never tells collab "full" ahead of content written before it, and a Space
 * RPC request or a receipt follows what it covers.
 *
 * Transport: `H7` (`helpers/handshake-server.ts`). The handshake runs on
 * real timers; each case then switches to fake timers so a written Update
 * stays in the provider's `flushDelay` buffer until a case advances them.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const h7 = await vi.hoisted(async () => {
  const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
  m.installScriptedWebSocket();
  return m;
});

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { P_FULL, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { sendSpaceRpc } from '@web/data/yjs/space-rpc-client';
import { destroyH7Editors, openPrompt } from '@web/features/collab-editor/__tests__/helpers/h7-editors';
import {
  CANVAS_NAME, COPY, clearToasts, expectWarnings, paragraphs, posOf, resetHarness, select, typeText,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const { expectHandshake, resetServer } = h7;
type ScriptedServer = InstanceType<typeof h7.ScriptedServer>;

const PID = 'p1';
const CANVAS = docName.canvasSpace(PID, 's1');
const DOCUMENT = docName.documentSpace(PID, 'd1');
const TIMELINE = docName.timelineSpace(PID, 't1');
const SCENE = docName.threeDSpace(PID, 'x1');
const META = docName.projectMeta(PID);

let server: ScriptedServer;

/** What the cases drive on the real provider. */
interface Provider {
  sendStateless: (payload: string) => void;
  configuration: { flushDelay?: number | false };
}

/**
 * Opens a document on `H7` and switches to fake timers.
 * @param name - Canonical document name.
 * @returns The document and its provider.
 * @throws {AssertionError} When a precondition of `H7` does not hold.
 */
async function open(name: string): Promise<{ doc: Y.Doc; provider: Provider }> {
  const doc = getDoc(name);
  const provider = acquireDocProvider(name, doc);
  const parsed = name === CANVAS || name === DOCUMENT;
  await expectHandshake(name, doc, provider as never, { confirms: parsed });
  vi.useFakeTimers();
  return { doc, provider: provider as unknown as Provider };
}

/**
 * One local write the provider buffers.
 * @param doc - The document.
 * @param value - What is written.
 * @throws {never} Never.
 */
function write(doc: Y.Doc, value: number): void {
  doc.transact(() => { doc.getMap('probe').set('v', value); });
}

/**
 * Every frame of a document since a mark, with a stateless payload's type.
 * @param name - Canonical document name.
 * @param mark - The first frame index.
 * @returns `update`, `confirm`, `seen(n)` or the stateless type.
 * @throws {never} Never.
 */
function frames(name: string, mark: number): string[] {
  return server.frames.slice(mark).filter(({ frame }) => frame.name === name).flatMap(({ frame }) => {
    const kind = h7.kindOf(frame);
    if (kind !== 'other') return [kind];
    if (frame.kind !== 'stateless') return [];
    return [String((JSON.parse(frame.payload) as { type?: unknown }).type)];
  });
}

beforeEach(() => {
  changeLocale('en');
  server = resetServer();
  clearToasts();
});

afterEach(() => {
  vi.useRealTimers();
  destroyH7Editors();
  _resetCollabSocketForTests();
  clearAllDocSizes();
  resetHarness();
  _resetForTests();
});

afterAll(() => {
  h7.uninstallScriptedWebSocket();
});

describe('24.1 a stateless message leaves after the Updates written before it', () => {
  it.each([
    ['canvas', CANVAS],
    ['document', DOCUMENT],
    ['3d', SCENE],
    ['timeline', TIMELINE],
  ] as const)('W8-01 %s: a buffered Update goes before seen(n), and the buffer is empty afterwards', async (_label, name) => {
    const { doc } = await open(name);
    server.push(name, P_WARNING);
    const mark = server.mark();
    write(doc, 1);
    const n = server.push(name, P_FULL);
    expect(frames(name, mark)).toEqual(['update', `seen(${n})`]);
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(name, mark).filter((kind) => kind === 'update')).toEqual(['update']);
  });

  it('W8-02 sendStateless sends the buffered Update first; with nothing buffered it sends the message alone', async () => {
    const { doc, provider } = await open(CANVAS);
    const mark = server.mark();
    write(doc, 1);
    provider.sendStateless('{"type":"probe"}');
    expect(frames(CANVAS, mark)).toEqual(['update', 'probe']);
    await vi.advanceTimersByTimeAsync(0);
    const empty = server.mark();
    provider.sendStateless('{"type":"probe"}');
    expect(frames(CANVAS, empty)).toEqual(['probe']);
    expect(frames(CANVAS, mark).filter((kind) => kind === 'update')).toEqual(['update']);
  });

  it('W8-03 a Space RPC request on the meta provider goes after the Update buffered on meta', async () => {
    const { doc, provider } = await open(META);
    const mark = server.mark();
    write(doc, 1);
    void sendSpaceRpc(provider as never, { type: 'space:delete', payload: { spaceId: 'sp-1' } }, { idGen: () => 'rpc-1', timeoutMs: 50 })
      .catch(() => undefined);
    expect(frames(META, mark)).toEqual(['update', 'space:delete']);
    await vi.advanceTimersByTimeAsync(100);
  });

  it('W8-04 a write and flushDelay later: [update, confirm], nothing sent empty before the receipt', async () => {
    const { doc } = await open(CANVAS);
    const mark = server.mark();
    write(doc, 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames(CANVAS, mark)).toEqual(['update', 'confirm']);
  });

  it('W8-05 a buffered keystroke goes before seen(n); the keystroke after it is refused with T_ADD and sends nothing', async () => {
    const open7 = await openPrompt({ kind: 'textBody', content: paragraphs('hello') });
    server.push(CANVAS_NAME, P_WARNING);
    vi.useFakeTimers();
    const mark = server.mark();
    select(open7.view, posOf(open7.view.state.doc, 'hello', 5));
    typeText(open7.view, 'a');
    const n = server.push(CANVAS_NAME, P_FULL);
    clearToasts();
    typeText(open7.view, 'b');
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(CANVAS_NAME, mark).filter((kind) => kind !== 'confirm')).toEqual(['update', `seen(${n})`]);
    expectWarnings(COPY.T_ADD);
    expect(open7.view.state.doc.textContent).toBe('helloa');
  });
});

describe('24.5 the receipt waits the provider\'s own flushDelay', () => {
  it('W8-14 flushDelay 5: nothing at 4 ms, [update, confirm] at 5 ms; the receipt timer is set for 5', async () => {
    const { doc, provider } = await open(CANVAS);
    provider.configuration.flushDelay = 5;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const mark = server.mark();
    write(doc, 1);
    await vi.advanceTimersByTimeAsync(4);
    expect(frames(CANVAS, mark)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames(CANVAS, mark)).toEqual(['update', 'confirm']);
    const delays = timers.mock.calls.map((call) => call[1]);
    // The provider's flush timer and the binding's receipt timer.
    expect(delays.filter((delay) => delay === 5)).toHaveLength(2);
    timers.mockRestore();
  });
});
