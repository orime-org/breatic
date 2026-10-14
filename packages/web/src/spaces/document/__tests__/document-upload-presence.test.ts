// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The uploader's claims in awareness, and their renewal while the page is in
 * the background (inner#1351 + inner#1390 design §5.5 在场声明, A11).
 *
 * Two real y-protocols Awareness instances are linked the way the provider
 * links them. A hidden tab's main-thread timers run at most once in 30 s
 * (measured, `2026-10-14-1351-worker-timer-throttling-nodebug-probe.mjs`), so
 * the uploader's own renewal interval is stopped here and only the renewal
 * the controller is handed keeps the claim alive at the peer.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { claimIn } from '@web/spaces/document/document-pending-status';
import {
  createUploadController,
  type AttachedBody,
  type UploadOutcome,
  type UploadController,
} from '@web/spaces/document/document-upload-controller';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** One body on the uploader's page and its peer's view of awareness. */
interface Side {
  doc: Y.Doc;
  mine: Awareness;
  peer: Awareness;
  body: AttachedBody;
}

/**
 * A body with an awareness linked to a peer's.
 * @param spaceId - Its Space.
 * @returns The side.
 */
function side(spaceId: string): Side {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const mine = new Awareness(doc);
  const peer = new Awareness(new Y.Doc());
  // A hidden tab: the uploader's own renewal does not run.
  clearInterval((mine as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
  mine.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    applyAwarenessUpdate(peer, encodeAwarenessUpdate(mine, [...added, ...updated, ...removed]), 'wire');
  });
  mine.setLocalState({ user: { name: 'me' } });
  const body: AttachedBody = {
    spaceId,
    doc,
    awareness: mine,
    writeAccess: () => 'granted',
    onWriteAccess: () => () => {},
  };
  return { doc, mine, peer, body };
}

/**
 * Inserts a pending image straight into a body.
 * @param doc - The doc.
 * @param uploadId - The upload.
 */
function pending(doc: Y.Doc, uploadId: string): void {
  doc.transact(() => {
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', uploadId);
    const image = new Y.XmlElement('image');
    image.setAttribute('url', '');
    image.setAttribute('uploadId', uploadId);
    container.insert(0, [image]);
    const group = documentBodyFragment(doc).get(0) as Y.XmlElement;
    group.insert(group.length, [container]);
  });
}

/** What the test controls. */
interface Rig {
  controller: UploadController;
  settle: Map<string, (outcome: UploadOutcome) => void>;
  ticks: { tick: (() => void) | null; started: number; stopped: number };
}

/**
 * A controller with a renewal the test drives.
 * @returns The rig.
 */
function rig(): Rig {
  const settle = new Map<string,(outcome: UploadOutcome) => void>();
  const ticks = { tick: null as (() => void) | null, started: 0, stopped: 0 };
  const controller = createUploadController({
    run: (uploadId) =>
      new Promise((resolve) => {
        settle.set(uploadId, resolve);
      }),
    register: () => {},
    unregister: () => {},
    renew: (tick) => {
      ticks.tick = tick;
      ticks.started += 1;
      return () => {
        ticks.tick = null;
        ticks.stopped += 1;
      };
    },
  });
  return { controller, settle, ticks };
}

/**
 * Lets queued microtasks run.
 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * The claim the peer sees.
 * @param s - The side.
 * @param uploadId - The upload.
 * @returns The claim.
 */
function seen(s: Side, uploadId: string): string | null {
  return claimIn(s.peer.getStates() as Map<number, Record<string, unknown>>, uploadId);
}

describe('claims', () => {
  it('an upload in flight is claimed as uploading in every attached body', async () => {
    const { controller } = rig();
    const a = side('space-a');
    const b = side('space-b');
    controller.attach(a.body);
    controller.attach(b.body);
    controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await flush();
    expect(seen(a, 'u1')).toBe('uploading');
    expect(seen(b, 'u1')).toBe('uploading');
  });

  it('a failed upload is claimed as failed', async () => {
    const { controller, settle } = rig();
    const a = side('space-a');
    controller.attach(a.body);
    controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    settle.get('u1')!({ ok: false, failure: { messageKey: 'canvas.upload.failed', params: {}, retryable: true } });
    await flush();
    expect(seen(a, 'u1')).toBe('failed');
  });

  it('a finished upload still waiting to be written stays claimed as uploading, and the claim goes once it is written', async () => {
    const { controller, settle } = rig();
    const a = side('space-a');
    let access: 'granted' | 'denied' = 'denied';
    const listeners = new Set<() => void>();
    controller.attach({
      ...a.body,
      writeAccess: () => access,
      onWriteAccess: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    pending(a.doc, 'u1');
    controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    settle.get('u1')!({ ok: true, result: { url: 'https://cdn.example/x.png' } });
    await flush();
    expect(seen(a, 'u1')).toBe('uploading');
    access = 'granted';
    listeners.forEach((listener) => {
      listener();
    });
    await flush();
    expect(seen(a, 'u1')).toBeNull();
  });

  it('a detached body withdraws its claims', async () => {
    const { controller } = rig();
    const a = side('space-a');
    const detach = controller.attach(a.body);
    controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await flush();
    detach();
    expect(seen(a, 'u1')).toBeNull();
  });
});

describe('renewal while the tab is in the background', () => {
  it('runs while there are claims, renews every attached body, and stops when none are left', async () => {
    const { controller, settle, ticks } = rig();
    const a = side('space-a');
    const b = side('space-b');
    controller.attach(a.body);
    controller.attach(b.body);
    expect(ticks.started).toBe(0);
    controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await flush();
    expect(ticks.started).toBe(1);
    for (let elapsed = 0; elapsed < 45_000; elapsed += 15_000) {
      await vi.advanceTimersByTimeAsync(15_000);
      ticks.tick?.();
    }
    expect(seen(a, 'u1')).toBe('uploading');
    expect(seen(b, 'u1')).toBe('uploading');
    settle.get('u1')!({ ok: true, result: { url: 'https://cdn.example/x.png' } });
    await flush();
    expect(ticks.stopped).toBe(1);
  });

  it('without the renewal the peer drops the claim once it is 30 s old', async () => {
    const { controller } = rig();
    const a = side('space-a');
    controller.attach(a.body);
    controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await flush();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(seen(a, 'u1')).toBeNull();
  });
});
