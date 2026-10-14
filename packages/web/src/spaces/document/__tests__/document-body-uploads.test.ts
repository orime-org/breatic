// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One open body's link to the page's upload controller (inner#1351 +
 * inner#1390 design §5.5): what its pending blocks read — this page's record,
 * this page's write access, whether the server refused the body, and what
 * other clients claim — and what tells them it changed.
 */

import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { encodeInitialSpaceContent } from '@breatic/shared';

import { openBodyUploads, type BodyConnection } from '@web/spaces/document/document-body-uploads';
import {
  createUploadController,
  type UploadOutcome,
  type WriteAccess,
} from '@web/spaces/document/document-upload-controller';

/** What the test controls. */
interface Rig {
  open: ReturnType<typeof openBodyUploads>;
  settle: Map<string, (outcome: UploadOutcome) => void>;
  awareness: Awareness;
  set: (access: WriteAccess, refused?: boolean) => void;
}

/**
 * A body opened against a controller whose uploads the test settles.
 * @returns The rig.
 */
function rig(): Rig {
  const settle = new Map<string,(outcome: UploadOutcome) => void>();
  const controller = createUploadController({
    run: (uploadId) => new Promise((resolve) => settle.set(uploadId, resolve)),
    register: () => {},
    unregister: () => {},
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { name: 'me' } });
  let access: WriteAccess = 'granted';
  let refused = false;
  const listeners = new Set<() => void>();
  const connection: BodyConnection = {
    awareness,
    writeAccess: () => access,
    refused: () => refused,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const open = openBodyUploads(controller, { spaceId: 'space-a', doc, connection });
  return {
    open,
    settle,
    awareness,
    set: (next, nextRefused = false) => {
      access = next;
      refused = nextRefused;
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
}

/**
 * Lets queued microtasks run.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('what a pending block reads', () => {
  it('holds this page\'s record of an upload it started', () => {
    const { open } = rig();
    open.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    expect(open.pending.factsOf('u1').entry?.phase).toBe('uploading');
  });

  it('holds this page\'s write access and whether the server refused the body', () => {
    const { open, set } = rig();
    expect(open.pending.factsOf('u1')).toMatchObject({ access: 'granted', refused: false });
    set('denied', true);
    expect(open.pending.factsOf('u1')).toMatchObject({ access: 'denied', refused: true });
  });

  it('holds what another client claims about an upload', () => {
    const { open, awareness } = rig();
    const peer = new Awareness(new Y.Doc());
    peer.setLocalState({ uploads: { u9: 'failed' } });
    // A peer's state, as the provider would apply it.
    awareness.states.set(peer.clientID, peer.getLocalState()!);
    expect(open.pending.factsOf('u9').claim).toBe('failed');
  });
});

describe('what tells it something changed', () => {
  it('an upload ending, the write access changing and awareness changing each call back', async () => {
    const { open, settle, set, awareness } = rig();
    const listener = vi.fn();
    open.pending.subscribe(listener);
    open.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    const afterStart = listener.mock.calls.length;
    expect(afterStart).toBeGreaterThan(0);
    settle.get('u1')!({ ok: false, failure: { messageKey: 'canvas.upload.failed', params: {}, retryable: true } });
    await flush();
    const afterEnd = listener.mock.calls.length;
    expect(afterEnd).toBeGreaterThan(afterStart);
    set('denied');
    expect(listener.mock.calls.length).toBeGreaterThan(afterEnd);
    const afterAccess = listener.mock.calls.length;
    awareness.setLocalStateField('user', { name: 'renamed' });
    expect(listener.mock.calls.length).toBeGreaterThan(afterAccess);
  });

  it('a retry runs the failed upload again', async () => {
    const { open, settle } = rig();
    open.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    settle.get('u1')!({ ok: false, failure: { messageKey: 'canvas.upload.failed', params: {}, retryable: true } });
    await flush();
    open.pending.retry('u1');
    expect(open.pending.factsOf('u1').entry?.phase).toBe('uploading');
  });
});

describe('closing the body', () => {
  it('withdraws its claims', async () => {
    const { open, awareness } = rig();
    open.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await flush();
    expect(awareness.getLocalState()?.['uploads']).toEqual({ u1: 'uploading' });
    open.detach();
    expect(awareness.getLocalState()?.['uploads']).toEqual({});
  });
});
