// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { CanvasNodeFields, NodeType } from '@breatic/shared';
import * as Y from 'yjs';
import { describe, it, expect, beforeEach } from 'vitest';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  isNodeHandling,
  nodeHasLiveLease,
  restoreNodeMedia,
  setNodeHandling,
} from '@web/data/yjs/canvas-space';

const PID = 'p1';
const SID = 's1';

/**
 * Builds a minimal wire node fixture for the restore invariants.
 * @param type - Node modality.
 * @param data - Data overrides merged onto the required-field defaults.
 * @param id - Node id (defaults to `n1`).
 * @returns A complete {@link CanvasNodeFields}.
 */
function fields(
  type: NodeType,
  data: Partial<CanvasNodeFields['data']> = {},
  id = 'n1',
): CanvasNodeFields {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      name: 'N',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
      ...data,
    },
  };
}

/**
 * Reads the live `data` Y.Map of a node in the test project/space.
 * @param id - Node id (defaults to `n1`).
 * @returns The node's data Y.Map.
 */
function nodeData(id = 'n1'): Y.Map<unknown> {
  return (
    getDoc(docName.canvasSpace(PID, SID))
      .getMap('nodesMap')
      .get(id) as Y.Map<unknown>
  ).get('data') as Y.Map<unknown>;
}

describe('restoreNodeMedia + nodeHasLiveLease (#1619 history restore, 关键路径)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('INV-3: writes the restored content back to the node', () => {
    addNode(PID, SID, fields('image', { content: 'old.png' }));
    restoreNodeMedia(PID, SID, 'n1', {
      content: 'restored.png',
      coverUrl: undefined,
    });
    expect(nodeData().get('content')).toBe('restored.png');
  });

  it('INV-8: image restore does NOT write coverUrl (asset-GC phantom-ref leak fix, Gate1-R4 HIGH)', () => {
    addNode(PID, SID, fields('image', { content: 'old.png' }));
    restoreNodeMedia(PID, SID, 'n1', {
      content: 'restored.png',
      coverUrl: undefined,
    });
    expect(nodeData().get('coverUrl')).toBeUndefined();
  });

  it('INV-8: video restore writes content + coverUrl in one transaction', () => {
    addNode(PID, SID, fields('video', { content: 'old.mp4', coverUrl: 'oldcover.jpg' }));
    restoreNodeMedia(PID, SID, 'n1', {
      content: 'restored.mp4',
      coverUrl: 'newcover.jpg',
    });
    expect(nodeData().get('content')).toBe('restored.mp4');
    expect(nodeData().get('coverUrl')).toBe('newcover.jpg');
  });

  it('INV-8: video restore with coverUrl=null deletes coverUrl (no stale poster)', () => {
    addNode(PID, SID, fields('video', { content: 'old.mp4', coverUrl: 'oldcover.jpg' }));
    restoreNodeMedia(PID, SID, 'n1', { content: 'restored.mp4', coverUrl: null });
    expect(nodeData().get('coverUrl')).toBeUndefined();
  });

  it('clears a prior errorMessage (restoring a good result over an error state)', () => {
    // A node whose last generation failed: no content, an error message
    // (state stays 'idle', deriveStatus → error).
    addNode(PID, SID, fields('image', { errorMessage: 'gen failed' }));
    restoreNodeMedia(PID, SID, 'n1', {
      content: 'restored.png',
      coverUrl: undefined,
    });
    expect(nodeData().get('errorMessage')).toBeUndefined();
  });

  it('INV-7: does NOT write state / handlingBy / leaseGen → a concurrent live lease is not defeated', () => {
    addNode(PID, SID, fields('image'));
    // A concurrent client opens a handling lease: state='handling' + handlingBy
    // + leaseGen (the fencing counter, bumped to 1 on the first lease).
    const lease = setNodeHandling(PID, SID, 'n1', 'u1');
    expect(lease).toBeDefined();
    const leaseGenBefore = nodeData().get('leaseGen');
    expect(leaseGenBefore).toBe(1);
    // A restore slips through the fresh-read gate window and writes content.
    restoreNodeMedia(PID, SID, 'n1', {
      content: 'restored.png',
      coverUrl: undefined,
    });
    // Content landed, but ALL THREE lease fields are untouched: the busy gate
    // still reads 'handling', handlingBy survives, so the in-flight gen's
    // completeNodeHandling still owns its lease and its billed result is safe.
    expect(nodeData().get('content')).toBe('restored.png');
    expect(nodeData().get('state')).toBe('handling');
    expect(nodeData().get('handlingBy')).toBeDefined();
    // leaseGen in particular must NOT move — a restore that bumped the fencing
    // counter would let a superseded gen's `gen` value be reused and land. This
    // pins the third prong of the "restore never writes state/handlingBy/leaseGen"
    // invariant that the state/handlingBy assertions above leave unverified.
    expect(nodeData().get('leaseGen')).toBe(leaseGenBefore);
  });

  it('nodeHasLiveLease reflects handlingBy presence (gate belt for the fresh re-read)', () => {
    addNode(PID, SID, fields('image'));
    expect(nodeHasLiveLease(PID, SID, 'n1')).toBe(false);
    setNodeHandling(PID, SID, 'n1', 'u1');
    expect(nodeHasLiveLease(PID, SID, 'n1')).toBe(true);
  });

  it('nodeHasLiveLease reads handlingBy, NOT state — a lease surviving a state revert still gates', () => {
    addNode(PID, SID, fields('image'));
    // Open a lease (state='handling' + handlingBy), then let a concurrent
    // content write (setNodeContent / a restore) converge state back to 'idle'
    // WITHOUT clearing the lease — the divergent (state≠'handling', handlingBy
    // present) case the belt exists for (see nodeHasLiveLease TSDoc).
    setNodeHandling(PID, SID, 'n1', 'u1');
    nodeData().set('state', 'idle');
    // The two gates now disagree, which is the whole point: isNodeHandling
    // (state-only) misses the live lease...
    expect(isNodeHandling(PID, SID, 'n1')).toBe(false);
    expect(nodeData().get('handlingBy')).toBeDefined();
    // ...but nodeHasLiveLease reads handlingBy, so it still reports the lease. A
    // broken `return state === 'handling'` reimplementation would return false
    // here — the distinguishing invariant no other assertion in the suite pins.
    expect(nodeHasLiveLease(PID, SID, 'n1')).toBe(true);
  });

  it('is a no-op on a missing node (no throw)', () => {
    expect(() =>
      restoreNodeMedia(PID, SID, 'ghost', {
        content: 'x.png',
        coverUrl: undefined,
      }),
    ).not.toThrow();
    expect(nodeHasLiveLease(PID, SID, 'ghost')).toBe(false);
  });
});
