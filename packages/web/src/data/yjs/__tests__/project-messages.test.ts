import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

import { docName, getDoc, _resetForTests } from '@/data/yjs/manager';
import {
  appendProjectMessage,
  readProjectMessages,
} from '@/data/yjs/project-meta';

const PROJECT_ID = 'p-messages';

describe('projectMessages — Y.Array read / write helpers', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('readProjectMessages on a fresh doc returns []', () => {
    const doc = getDoc(docName.projectMeta(PROJECT_ID));
    expect(readProjectMessages(doc)).toEqual([]);
  });

  it('appendProjectMessage round-trips a missing-node entry', () => {
    appendProjectMessage(PROJECT_ID, {
      id: 'm-1',
      kind: 'missing-node',
      message: 'project_message.missing_node.no_actor',
      context: { nodeId: 'n-42' },
      createdAt: 1700000000000,
    });
    const doc = getDoc(docName.projectMeta(PROJECT_ID));
    const out = readProjectMessages(doc);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'm-1',
      kind: 'missing-node',
      message: 'project_message.missing_node.no_actor',
      createdAt: 1700000000000,
    });
    expect(out[0].context).toEqual({ nodeId: 'n-42' });
  });

  it('appendProjectMessage round-trips a space-deleted entry with snapshot name', () => {
    appendProjectMessage(PROJECT_ID, {
      id: 'm-2',
      kind: 'space-deleted',
      actor: 'user-1',
      spaceId: 'sp-1',
      spaceName: 'Main canvas',
      createdAt: 1700000001000,
    });
    const out = readProjectMessages(getDoc(docName.projectMeta(PROJECT_ID)));
    expect(out[0]).toMatchObject({
      kind: 'space-deleted',
      actor: 'user-1',
      spaceId: 'sp-1',
      spaceName: 'Main canvas',
    });
  });

  it('readProjectMessages preserves insertion order', () => {
    appendProjectMessage(PROJECT_ID, {
      id: 'm-a',
      kind: 'space-created',
      spaceId: 'sp-a',
      createdAt: 1,
    });
    appendProjectMessage(PROJECT_ID, {
      id: 'm-b',
      kind: 'space-locked',
      spaceId: 'sp-a',
      createdAt: 2,
    });
    appendProjectMessage(PROJECT_ID, {
      id: 'm-c',
      kind: 'space-unlocked',
      spaceId: 'sp-a',
      createdAt: 3,
    });
    const ids = readProjectMessages(
      getDoc(docName.projectMeta(PROJECT_ID)),
    ).map((m) => m.id);
    expect(ids).toEqual(['m-a', 'm-b', 'm-c']);
  });

  it('readProjectMessages tolerates malformed entries by skipping them', () => {
    // Manually push a malformed Y.Map (simulating a forward-compat schema
    // mismatch). The Zod parse fails → entry skipped, not crashed.
    const doc = getDoc(docName.projectMeta(PROJECT_ID));
    const arr = doc.getArray<Y.Map<unknown>>('projectMessages');
    doc.transact(() => {
      const bad = new Y.Map<unknown>();
      bad.set('id', 'm-bad');
      bad.set('kind', 'totally-unknown'); // invalid enum
      bad.set('createdAt', 1);
      arr.push([bad]);
    });

    appendProjectMessage(PROJECT_ID, {
      id: 'm-good',
      kind: 'space-restored',
      spaceId: 'sp-1',
      createdAt: 2,
    });

    const out = readProjectMessages(doc);
    expect(out.map((m) => m.id)).toEqual(['m-good']);
  });
});
