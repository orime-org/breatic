import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { appendSpace, removeSpace } from '@web/data/yjs/project-meta';

/**
 * Regression pins for the P0 cross-side Yjs root-type mismatch that
 * blocked Space creation end-to-end after PR-b shipped.
 *
 * Bug shape: `packages/web/src/data/yjs/project-meta.ts` accessed the
 * `spaces` root via `doc.getArray<Y.Map<unknown>>(...)` while the
 * collab side (`packages/collab/src/space-rpc.ts`, `auth.ts`, and
 * `core/src/db/yjs-bootstrap.ts`) all used `doc.getMap("spaces")`.
 *
 * Yjs treats `getArray("spaces")` and `getMap("spaces")` as **separate
 * roots**: writes the server made to the Map never appeared to the
 * client's Array observer, so the safety timeout fired with "Space
 * 创建超时" even though the RPC succeeded.
 *
 * These tests lock in:
 *   - `spaces` root is a Y.Map keyed by spaceId
 *   - `appendSpace` / `removeSpace` operate via Map API
 *   - reading the same root with `getMap` after writing returns the
 *     entry (the Array-shape regression would surface as `has(id)`
 *     returning false because the entry went into a sibling root)
 */
const PID = 'p-spaces-shape';

describe('meta.spaces — Y.Map root type (P0 regression pin)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('appendSpace stores the entry as Y.Map[spaceId]', () => {
    appendSpace(PID, { id: 'sp-1', name: 'Main', type: 'canvas' });
    const doc = getDoc(docName.projectMeta(PID));
    // Authoritative cross-side check: Map root, key=spaceId.
    const spacesMap = doc.getMap<Y.Map<unknown>>('spaces');
    expect(spacesMap.has('sp-1')).toBe(true);
    const entry = spacesMap.get('sp-1');
    expect(entry).toBeInstanceOf(Y.Map);
    expect(entry?.get('id')).toBe('sp-1');
    expect(entry?.get('name')).toBe('Main');
    expect(entry?.get('type')).toBe('canvas');
  });

  it('removeSpace deletes the entry by spaceId', () => {
    appendSpace(PID, { id: 'sp-1', name: 'Main', type: 'canvas' });
    appendSpace(PID, { id: 'sp-2', name: 'Reel', type: 'timeline' });
    removeSpace(PID, 'sp-1');
    const spacesMap = getDoc(docName.projectMeta(PID)).getMap<Y.Map<unknown>>(
      'spaces',
    );
    expect(spacesMap.has('sp-1')).toBe(false);
    expect(spacesMap.has('sp-2')).toBe(true);
  });

  it('Yjs refuses cross-type access on the same root key (proves the bug shape)', () => {
    // After Map writes touch "spaces", a follow-up `getArray("spaces")`
    // throws. That's exactly why the PR-b bug presented as silence on
    // the client: the previous client code called getArray FIRST, so
    // the root was registered as an Array, and later collab Map
    // writes synced into a sibling root the observer never watched.
    appendSpace(PID, { id: 'sp-1', name: 'Main', type: 'canvas' });
    const doc = getDoc(docName.projectMeta(PID));
    expect(() => doc.getArray<Y.Map<unknown>>('spaces' as never)).toThrow();
  });

  it('ingests a Map-shaped update from a peer (mirrors collab space-rpc handleCreate)', () => {
    // Build a "remote" doc the way the collab process does, then
    // ship its update through Yjs sync and verify the client reads
    // it back via the Map API.
    const remote = new Y.Doc();
    remote.transact(() => {
      const remoteSpaces = remote.getMap('spaces');
      const entry = new Y.Map<unknown>();
      entry.set('id', 'sp-remote');
      entry.set('name', 'From collab');
      entry.set('type', 'canvas');
      entry.set('order', 0);
      entry.set('locked', false);
      entry.set('createdAt', Date.now());
      remoteSpaces.set('sp-remote', entry);
    });
    const update = Y.encodeStateAsUpdate(remote);

    const local = getDoc(docName.projectMeta(PID));
    Y.applyUpdate(local, update);

    const spacesMap = local.getMap<Y.Map<unknown>>('spaces');
    expect(spacesMap.has('sp-remote')).toBe(true);
    expect(spacesMap.get('sp-remote')?.get('name')).toBe('From collab');
  });
});
