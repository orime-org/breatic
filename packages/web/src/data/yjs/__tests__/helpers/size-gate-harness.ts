// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect } from 'vitest';
import { act } from '@testing-library/react';
import * as encoding from 'lib0/encoding';
import type * as Y from 'yjs';
import * as shared from '@breatic/shared';

import { acquireDocProvider } from '@web/data/yjs/collab-socket';
import { getDoc } from '@web/data/yjs/manager';
import { reserveSpaceRoom } from '@web/data/yjs/space-write';
import { sizeGateProviders, type SizeGateProvider } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { docSizePayload, type DocSizePush } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

/**
 * Acquires the registry entry for a Space document, the way an open tab does,
 * with the provider attached, authenticated and writable.
 * Requires `vi.mock('@hocuspocus/provider', …)` with `providerMockModule`.
 * @param name - Space content document name.
 * @returns The registered document and its provider stand-in.
 * @throws {Error} When acquiring fails.
 */
export function openSizedDoc(name: string): { doc: Y.Doc; provider: SizeGateProvider } {
  const doc = getDoc(name);
  const provider = acquireDocProvider(name, doc) as unknown as SizeGateProvider;
  provider.isAttached = true;
  provider.isAuthenticated = true;
  provider.authorizedScope = 'read-write';
  return { doc, provider };
}

/**
 * The newest provider stand-in built for a document name (after a rebuild,
 * the replacement).
 * @param name - Document name.
 * @returns The provider.
 * @throws {Error} When none was built for the name.
 */
export function latestProvider(name: string): SizeGateProvider {
  const found = [...sizeGateProviders].reverse().find((p) => p.configuration.name === name);
  if (!found) throw new Error(`no provider was built for ${name}`);
  return found;
}

/**
 * Delivers one `doc:size` push on a provider.
 * @param provider - Provider the push arrives on.
 * @param push - The push body.
 * @throws {Error} When a listener throws.
 */
export function pushSize(provider: SizeGateProvider, push: DocSizePush): void {
  act(() => {
    provider.emit('stateless', { payload: docSizePayload(push) });
  });
}

/**
 * Delivers the server's SyncStep1 for the document and lets the receipt
 * microtask run, so local writes are confirmable afterwards.
 * @param name - Document name.
 * @param provider - Provider it arrives on.
 * @throws {Error} When a listener throws.
 */
export async function handshake(name: string, provider: SizeGateProvider): Promise<void> {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
  await act(async () => {
    provider.emit('message', { event: { data: encoding.toUint8Array(encoder) } });
    await Promise.resolve();
  });
}

/**
 * Lets queued microtasks (the confirmation request) run.
 * @throws {never} Never.
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Answers the newest `sync:confirm` request on the provider with a success.
 * @param provider - Provider that sent the request.
 * @throws {AssertionError} When no request was sent.
 */
export async function confirmLatest(provider: SizeGateProvider): Promise<void> {
  await flush();
  const requests = provider.sendStateless.mock.calls
    .map(([body]) => JSON.parse(String(body)) as { type: string; id: string })
    .filter((body) => body.type === 'sync:confirm');
  expect(requests.length).toBeGreaterThan(0);
  const id = requests.at(-1)!.id;
  await act(async () => {
    provider.emit('stateless', { payload: JSON.stringify({ type: 'sync:confirmed', id, ok: true }) });
    await Promise.resolve();
  });
}

/**
 * Closes the document the way collab refuses an over-size update.
 * @param provider - Provider whose document is closed.
 * @throws {AssertionError} When shared does not export the close reason.
 */
export function refuseTooLarge(provider: SizeGateProvider): void {
  const reason = (shared as Record<string, unknown>).COLLAB_DOCUMENT_TOO_LARGE_REASON;
  expect(typeof reason).toBe('string');
  act(() => {
    provider.emit('close', { event: { code: 1000, reason } });
  });
}

/**
 * Reports the new provider's first sync after a rebuild.
 * @param provider - The replacement provider.
 * @throws {Error} When a listener throws.
 */
export function markSynced(provider: SizeGateProvider): void {
  act(() => {
    provider.emit('synced', { state: true });
  });
}

/**
 * Whether `n` bytes fit right now; a successful reservation is released at once.
 * @param name - Document name.
 * @param n - Bytes to try.
 * @returns Whether a reservation of `n` bytes was granted.
 * @throws {never} The gateway does not throw.
 */
export function probe(name: string, n: number): boolean {
  const result = reserveSpaceRoom(name, n, { notify: false });
  if (result.ok) result.reservation.release();
  return result.ok;
}

/**
 * Asserts the available room is exactly `room` bytes (spec 0.3). Only for
 * the `normal` and `warning` phases: at `full` a reservation answers `full`.
 * @param name - Document name.
 * @param room - The expected room.
 * @throws {AssertionError} When the room differs.
 */
export function expectRoom(name: string, room: number): void {
  if (room === 0) {
    expect(probe(name, 1)).toBe(false);
    expect(reserveSpaceRoom(name, 1, { notify: false })).toEqual({ ok: false, reason: 'no_room', room: 0 });
    return;
  }
  expect(probe(name, room)).toBe(true);
  expect(probe(name, room + 1)).toBe(false);
}
