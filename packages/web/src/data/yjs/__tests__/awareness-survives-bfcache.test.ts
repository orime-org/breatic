// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Coming back from the back-forward cache has to leave collaboration working.
 *
 * The browser has a two-part contract for a page that is put aside and later
 * restored: tear things down in `pagehide`, and set them back up in `pageshow`.
 * The collaboration provider implements the first half for us — on `pagehide`
 * it removes this client's awareness state — and leaves the second half to the
 * application. Nobody wrote it, so the state stayed removed for the rest of the
 * page's life.
 *
 * That single omission breaks two things at once, and neither announces itself:
 *
 *   - The 15-second heartbeat stops for good. y-protocols only renews the local
 *     clock `if (this.getLocalState() !== null)`, and the state that condition
 *     reads is exactly what was removed. The timer keeps firing and keeps doing
 *     nothing. The server then sees somebody who is connected but silent, and
 *     the presence sweep turns them off — permanently, because coming back
 *     requires a heartbeat.
 *   - The caret disappears for everyone. `setLocalStateField` is a no-op while
 *     the state is null, and that is the only way this client publishes its
 *     cursor and focus.
 *
 * The state is created in exactly one place — the `Awareness` constructor's
 * last line, `setLocalState({})` — and that runs once, when the provider is
 * built. A restored page does not rebuild it: the whole JavaScript context
 * comes back as it was, so nothing re-runs that line and nothing else ever
 * sets it. Reconnecting does not help either; it restores the socket, not the
 * state that decides whether anything is sent over it.
 *
 * These cases break it the way the library breaks it (calling the same
 * `removeAwarenessStates` its `pagehide` handler calls) so they cannot drift
 * from what actually happens.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';

/** Providers the registry built, each carrying a real Awareness. */
const { providerInstances } = vi.hoisted(() => ({
  providerInstances: [] as Array<{ awareness: unknown }>,
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProviderWebsocket: class {
    destroy = vi.fn();
  },
  HocuspocusProvider: class {
    destroy = vi.fn();
    attach = vi.fn();
    on = vi.fn();
    // A REAL awareness on the provider's real document, so the removal and the
    // restoration both run the library's own code rather than a stand-in.
    awareness: Awareness;
    constructor(config: { document: Y.Doc }) {
      this.awareness = new Awareness(config.document);
      providerInstances.push(this);
    }
  },
}));

const { acquireDocProvider, _resetCollabSocketForTests } = await import(
  '@web/data/yjs/collab-socket'
);

/** Fire the event a browser fires when it restores a page it had put aside. */
function firePageshow(persisted: boolean): void {
  window.dispatchEvent(
    Object.assign(new Event('pageshow'), { persisted }) as Event,
  );
}

/** Do to a provider exactly what the library's `pagehide` handler does. */
function simulatePageHide(provider: { awareness: Awareness; document: Y.Doc }): void {
  removeAwarenessStates(
    provider.awareness,
    [provider.awareness.doc.clientID],
    'page hide',
  );
}

let doc: Y.Doc;

beforeEach(() => {
  providerInstances.length = 0;
  doc = new Y.Doc();
});

afterEach(() => {
  _resetCollabSocketForTests();
  doc.destroy();
});

describe('awareness after a restored page', () => {
  it('is emptied by the page-hide half, which is the library doing its job', () => {
    const provider = acquireDocProvider('project-p/meta', doc) as unknown as {
      awareness: Awareness;
      document: Y.Doc;
    };
    expect(provider.awareness.getLocalState()).not.toBeNull();

    simulatePageHide(provider);

    expect(provider.awareness.getLocalState()).toBeNull();
  });

  it('is put back when the page is restored, so the heartbeat resumes', () => {
    const provider = acquireDocProvider('project-p/meta', doc) as unknown as {
      awareness: Awareness;
      document: Y.Doc;
    };
    simulatePageHide(provider);

    firePageshow(true);

    // Non-null is the whole requirement: it is what y-protocols' renewal loop
    // and `setLocalStateField` both test before doing anything.
    expect(provider.awareness.getLocalState()).not.toBeNull();
  });

  it('lets this client publish again, which is what the caret needs', () => {
    const provider = acquireDocProvider('project-p/meta', doc) as unknown as {
      awareness: Awareness;
      document: Y.Doc;
    };
    simulatePageHide(provider);
    // While the state is null this is silently a no-op — the second half of
    // the damage, and the half a presence-only fix would leave behind.
    provider.awareness.setLocalStateField('user', { focused: true });
    expect(provider.awareness.getLocalState()).toBeNull();

    firePageshow(true);
    provider.awareness.setLocalStateField('user', { focused: true });

    expect(provider.awareness.getLocalState()).toEqual({
      user: { focused: true },
    });
  });

  it('restores every open document, not just the one that was looked at', () => {
    const meta = acquireDocProvider('project-p/meta', doc) as unknown as {
      awareness: Awareness;
      document: Y.Doc;
    };
    const canvasDoc = new Y.Doc();
    const canvas = acquireDocProvider(
      'project-p/canvas-s',
      canvasDoc,
    ) as unknown as { awareness: Awareness; document: Y.Doc };
    simulatePageHide(meta);
    simulatePageHide(canvas);

    firePageshow(true);

    expect(meta.awareness.getLocalState()).not.toBeNull();
    expect(canvas.awareness.getLocalState()).not.toBeNull();
    canvasDoc.destroy();
  });

  it('leaves a healthy page alone on an ordinary load', () => {
    // `pageshow` also fires on a normal navigation, with `persisted` false.
    // Nothing was torn down then, and overwriting a live state would throw away
    // whatever cursor and focus this client is currently publishing.
    const provider = acquireDocProvider('project-p/meta', doc) as unknown as {
      awareness: Awareness;
      document: Y.Doc;
    };
    provider.awareness.setLocalStateField('user', { focused: true });

    firePageshow(false);

    expect(provider.awareness.getLocalState()).toEqual({
      user: { focused: true },
    });
  });
});
