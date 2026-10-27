// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type * as Y from 'yjs';
import type { CanvasProposal } from '@breatic/shared';

import type { ContentNodeView } from '@web/data/yjs/node-view';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import { readShots } from '@web/data/yjs/node-storyboard';
import { _resetForTests, destroyDoc, docName, getDoc } from '@web/data/yjs/manager';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import { useCurrentUserStore } from '@web/stores/current-user';
import { groupBackgroundFor } from '@web/spaces/canvas/group-background';
import { LAYER_STEP_PX, ROW_GAP_PX, occupiedRects, planFlowLayout, textFootprintHeight } from '@web/spaces/canvas/lib/place-flow';
import { EMPTY_NODE_SIZE, GROUP_PADDING, groupRectForMembers, mediaNodeHeight, type Rect } from '@web/spaces/canvas/group-geometry';
import { createEmptyNode, createGroupNode, type CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { writeProposalPrompt, type ProposalMention } from '@web/spaces/canvas/generate/proposal-prompt';
import { ApiException } from '@web/data/api/types';
import { COUNTS_COLUMN_FLOW_DEPTH, COUNTS_COLUMN_FLOW_REACH } from '@web/spaces/canvas/overlay-scale';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { CLIPBOARD_VERSION, type ClipboardNode, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { toast } from '@web/lib/toast';
import { canvasApi } from '@web/data/api/canvas';
import en from '@locales/en.json';

vi.mock('@web/lib/toast', () => ({
  toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));


/**
 * A clipboard payload of the given nodes, every one picked.
 * @param nodes - Its nodes.
 * @returns The payload.
 */
function payloadOf(nodes: ClipboardNode[]): ClipboardPayload {
  return { version: CLIPBOARD_VERSION, picked: nodes.map((n) => n.id), nodes, edges: [] };
}

describe('useNodeCreation', () => {
  beforeEach(() => {
    // The paste case below writes into a REAL canvas document, and documents
    // are cached per name across every test file in this process.
    _resetForTests();
    // The Space is open, as it is while its canvas is on screen.
    getDoc(docName.canvasSpace('p1', 's1'));
    useCurrentUserStore.getState().setUser({
      id: 'u-9',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
      membershipTier: 'base',
    });
  });

  it('createNodeAt writes an empty node of the type/position via addNode and returns its id', () => {
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const id = result.current.createNodeAt('image', { x: 100, y: 200 });

    expect(addNode).toHaveBeenCalledTimes(1);
    const [projectId, spaceId, node] = addNode.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(spaceId).toBe('s1');
    expect(node.id).toBe(id);
    expect(node.type).toBe('image');
    // The node is CENTRED on the given point (top-left = point − 288/2, 192/2).
    expect(node.position).toEqual({ x: 100 - 144, y: 200 - 96 });
    expect(node.data.name).toBe('Image');
    expect(node.data.createdBy).toBe('u-9');
    addNode.mockRestore();
  });

  it('pasteTextAt writes a text node whose BODY carries the pasted text', () => {
    // Call-through spy, deliberately: the pasted words travel as a plain
    // `content` string but LAND in the node's shared body — `addNode` drops
    // the plain field on the way. A mocked `addNode` can therefore only ever
    // see the field that gets thrown away, and a test asserting it stays
    // green with the handover broken (round-4, proved by mutation).
    const addNode = vi.spyOn(canvasSpace, 'addNode');
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const id = result.current.pasteTextAt('hello world', { x: 5, y: 6 });

    expect(addNode).toHaveBeenCalledTimes(1);
    const [, , node] = addNode.mock.calls[0];
    expect(node.id).toBe(id);
    expect(node.type).toBe('text');
    // Centred on the point (top-left = point − empty-node half-size).
    expect(node.position).toEqual({ x: 5 - 144, y: 6 - 96 });
    expect(node.data.createdBy).toBe('u-9');
    // What the user pasted is what the DOCUMENT says — read back through the
    // body, the only place the words live.
    const body = canvasSpace.getTextBody('p1', 's1', id);
    expect(body).not.toBeNull();
    expect(bodyToPlainText(body as Y.XmlFragment)).toBe('hello world');
    addNode.mockRestore();
  });

  it('createUploadNodeAt writes a media node and reports where it put it', () => {
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const created = result.current.createUploadNodeAt('image', { x: 7, y: 8 });

    expect(addNode).toHaveBeenCalledTimes(1);
    const [, , node] = addNode.mock.calls[0];
    expect(node.id).toBe(created.id);
    expect(node.type).toBe('image');
    // Centred on the point (top-left = point − empty-node half-size).
    expect(node.position).toEqual({ x: 7 - 144, y: 8 - 96 });
    // The top-left it reports is the one it wrote. A batch that becomes a
    // Group reads its members' positions from here, so there is one answer to
    // "where is node i" and the Group cannot be framed around a second one.
    expect(created.position).toEqual(node.position);
    // A node is created carrying no tasks: how it looks while one runs comes
    // from the counts the server writes (#186 §3.3).
    expect(node.data.createdBy).toBe('u-9');
    expect(node.data.taskCounts).toBeUndefined();
    addNode.mockRestore();
  });

  it('pastePayload clones clipboard nodes (offset + fresh ids + carried content) and returns their ids', async () => {
    // The text's history is registered with the server first.
    const paste = vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {} });
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const ids = await result.current.pastePayload(
      payloadOf([
        { id: 'a', type: 'image', position: { x: 10, y: 20 }, data: { name: 'Hero', content: 'a.png' } },
        { id: 'b', type: 'text', position: { x: 30, y: 40 }, data: { content: 'note' } },
      ]),
      { dx: 24, dy: 24 },
    );

    expect(ids).toHaveLength(2);
    const nodes = canvasSpace.readNodes(getDoc(docName.canvasSpace('p1', 's1')));
    const first = nodes.find((n) => n.id === ids?.[0]);
    expect(first?.type).toBe('image');
    expect(first?.position).toEqual({ x: 34, y: 44 });
    const data = first?.data as unknown as Record<string, unknown>;
    expect(data.content).toBe('a.png');
    // A pasted top-level clone is a root → COPY- prefixed (R2-C).
    expect(data.name).toBe('COPY-Hero');
    expect(canvasSpace.nodeDataMap(getDoc(docName.canvasSpace('p1', 's1')), ids?.[0] ?? '')?.get('createdBy')).toBe('u-9');
    paste.mockRestore();
  });

  // The Space's tab hidden while the server answers: the document is still
  // open, so the copies land in it (React runs effect cleanups on a hidden
  // Activity). A closed Space's document is gone and nothing is written.
  describe('a paste whose answer comes back after the Space left the screen', () => {
    /**
     * Start a paste whose server answer is held until `release` is called.
     * @returns The pending paste, the hook's unmount, and the release.
     */
    const pendingPaste = (): {
      done: Promise<string[] | null>;
      unmount: () => void;
      release: () => void;
    } => {
      let release = (): void => undefined;
      vi.spyOn(canvasApi, 'paste').mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ map: {} });
        }),
      );
      const { result, unmount } = renderHook(() => useNodeCreation('p1', 's1'));
      // A picture with content has a history row, so the paste waits on the server.
      const done = result.current.pastePayload(
        payloadOf([{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: { content: 'a.png' } }]),
        { dx: 0, dy: 0 },
      );
      return { done, unmount, release: () => release() };
    };

    it('writes the copies into a Space that is only hidden', async () => {
      const { done, unmount, release } = pendingPaste();
      unmount();
      release();
      const ids = await done;
      expect(ids).toHaveLength(1);
      expect(canvasSpace.readNodes(getDoc(docName.canvasSpace('p1', 's1'))).map((n) => n.id)).toEqual(ids);
      vi.restoreAllMocks();
    });

    it('puts a copy of a lone member at the top level when its Group was deleted meanwhile', async () => {
      canvasSpace.addNode('p1', 's1', {
        id: 'g',
        type: 'group',
        position: { x: 1000, y: 1000 },
        data: { name: 'G', createdAt: 0, createdBy: 'u-9', locked: false, attachments: [], width: 600, height: 400 },
      });
      let release = (): void => undefined;
      vi.spyOn(canvasApi, 'paste').mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ map: {} });
        }),
      );
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      // The member sits at (1040, 1040) on the canvas, (40, 40) inside the Group.
      const done = result.current.pastePayload(
        payloadOf([
          { id: 'm', type: 'image', parentId: 'g', position: { x: 1040, y: 1040 }, data: { content: 'a.png' } },
        ]),
        { dx: 24, dy: 24 },
        { externalParentAbs: new Map([['g', { x: 1000, y: 1000 }]]) },
      );
      canvasSpace.removeNode('p1', 's1', 'g');
      release();
      const [id] = (await done) ?? [];
      const copy = canvasSpace.readNodes(getDoc(docName.canvasSpace('p1', 's1'))).find((n) => n.id === id);
      expect(copy?.parentId).toBeUndefined();
      expect(copy?.position).toEqual({ x: 1064, y: 1064 });
      vi.restoreAllMocks();
    });

    it('puts a copy of a lone member at the top level when its Group was locked meanwhile', async () => {
      canvasSpace.addNode('p1', 's1', {
        id: 'g',
        type: 'group',
        position: { x: 1000, y: 1000 },
        data: { name: 'G', createdAt: 0, createdBy: 'u-9', locked: false, attachments: [], width: 600, height: 400 },
      });
      let release = (): void => undefined;
      vi.spyOn(canvasApi, 'paste').mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ map: {} });
        }),
      );
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      const done = result.current.pastePayload(
        payloadOf([
          { id: 'm', type: 'image', parentId: 'g', position: { x: 1040, y: 1040 }, data: { content: 'a.png' } },
        ]),
        { dx: 24, dy: 24 },
        { externalParentAbs: new Map([['g', { x: 1000, y: 1000 }]]) },
      );
      canvasSpace.setNodeLocked('p1', 's1', 'g', true);
      release();
      const [id] = (await done) ?? [];
      const copy = canvasSpace.readNodes(getDoc(docName.canvasSpace('p1', 's1'))).find((n) => n.id === id);
      expect(copy?.parentId).toBeUndefined();
      expect(copy?.position).toEqual({ x: 1064, y: 1064 });
      vi.restoreAllMocks();
    });

    it('keeps a copy of a lone member in its Group at the place the Group moved to', async () => {
      canvasSpace.addNode('p1', 's1', {
        id: 'g',
        type: 'group',
        position: { x: 1000, y: 1000 },
        data: { name: 'G', createdAt: 0, createdBy: 'u-9', locked: false, attachments: [], width: 600, height: 400 },
      });
      // Something already sits where the copy lands once the Group is at
      // (1500, 1000): (1500 + 64, 1000 + 64).
      canvasSpace.addNode('p1', 's1', {
        id: 'there',
        type: 'image',
        position: { x: 1564, y: 1064 },
        data: { name: 'T', createdAt: 0, createdBy: 'u-9', locked: false, attachments: [] },
      });
      let release = (): void => undefined;
      vi.spyOn(canvasApi, 'paste').mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ map: {} });
        }),
      );
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      const done = result.current.pastePayload(
        payloadOf([
          { id: 'm', type: 'image', parentId: 'g', position: { x: 1040, y: 1040 }, data: { content: 'a.png' } },
        ]),
        { dx: 24, dy: 24 },
        { externalParentAbs: new Map([['g', { x: 1000, y: 1000 }]]) },
      );
      canvasSpace.setNodePosition('p1', 's1', 'g', { x: 1500, y: 1000 }, null);
      release();
      const [id] = (await done) ?? [];
      const copy = canvasSpace.readNodes(getDoc(docName.canvasSpace('p1', 's1'))).find((n) => n.id === id);
      expect(copy?.parentId).toBe('g');
      // Stepped once past the node already on that spot.
      expect(copy?.position).toEqual({ x: 88, y: 88 });
      vi.restoreAllMocks();
    });

    it('writes nothing into a Space that was closed', async () => {
      const { done, release } = pendingPaste();
      destroyDoc(docName.canvasSpace('p1', 's1'));
      release();
      expect(await done).toBeNull();
      expect(canvasSpace.readNodes(getDoc(docName.canvasSpace('p1', 's1')))).toHaveLength(0);
      vi.restoreAllMocks();
    });
  });

  // Every paste steps past nodes already on its spot (inner#1235 A20). Read
  // through the real document: the step comes from what the document holds,
  // so a mocked `addNode` would leave nothing for the next paste to step past.
  describe('a paste onto a taken spot', () => {
    /**
     * Where each node in the canvas document sits, by id.
     * @param ids - The nodes to look up.
     * @returns Their stored positions, in order.
     */
    const placed = (ids: readonly string[]): { x: number; y: number }[] => {
      const nodes = canvasSpace.readNodes(getDoc(docName.canvasSpace('p1', 's1')));
      return ids.map((id) => {
        const found = nodes.find((node) => node.id === id);
        if (found === undefined) throw new Error(`no node ${id}`);
        return found.position;
      });
    };

    it('steps a second paste of the same text down and right by one step', () => {
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      const first = result.current.pasteTextAt('a', { x: 500, y: 500 });
      const second = result.current.pasteTextAt('a', { x: 500, y: 500 });
      expect(placed([first, second])).toEqual([
        { x: 356, y: 404 },
        { x: 380, y: 428 },
      ]);
    });

    it('steps a staggered pair whose box corner is free but one of whose nodes lands on a taken spot', async () => {
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      // The pair's bounding box starts at (0, 0), where neither node sits.
      const pair = payloadOf([
        { id: 'a', type: 'image', position: { x: 0, y: 300 }, data: {} },
        { id: 'b', type: 'image', position: { x: 400, y: 0 }, data: {} },
      ]);
      await result.current.pastePayload(pair, { dx: 0, dy: 0 });
      // Moved by (400, -300) the box corner (400, -300) is free and so is the
      // second node's spot, but the first node lands on the first copy's
      // second node at (400, 0).
      const again = await result.current.pastePayload(pair, { dx: 400, dy: -300 });
      expect(placed(again ?? [])).toEqual([
        { x: 424, y: 24 },
        { x: 824, y: -276 },
      ]);
    });

    it('measures a Group member where it is painted, not where it is stored', async () => {
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      canvasSpace.addNode('p1', 's1', {
        id: 'g',
        type: 'group',
        position: { x: 1000, y: 1000 },
        data: { name: 'G', createdAt: 0, createdBy: 'u-9', locked: false, attachments: [], width: 600, height: 400 },
      });
      canvasSpace.addNode('p1', 's1', {
        id: 'm',
        type: 'image',
        parentId: 'g',
        position: { x: 40, y: 40 },
        data: { name: 'M', createdAt: 0, createdBy: 'u-9', locked: false, attachments: [] },
      });
      const [pasted] = (await result.current.pastePayload(
        payloadOf([{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} }]),
        { dx: 1040, dy: 1040 },
      )) ?? [];
      expect(placed([pasted as string])).toEqual([{ x: 1064, y: 1064 }]);
    });

    it('steps a pasted Group when only one of its members would land on a taken spot', async () => {
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      canvasSpace.addNode('p1', 's1', {
        id: 'there',
        type: 'image',
        position: { x: 624, y: 624 },
        data: { name: 'T', createdAt: 0, createdBy: 'u-9', locked: false, attachments: [] },
      });
      // Clipboard positions are absolute, members included: shifted by 24 the
      // Group's corner (524, 524) is free, its member lands on (624, 624).
      const [group] = (await result.current.pastePayload(
        payloadOf([
          { id: 'g', type: 'group', position: { x: 500, y: 500 }, width: 600, height: 400, data: { width: 600, height: 400 } },
          { id: 'm', type: 'image', parentId: 'g', position: { x: 600, y: 600 }, data: {} },
        ]),
        { dx: 24, dy: 24 },
      )) ?? [];
      expect(placed([group as string])).toEqual([{ x: 548, y: 548 }]);
    });

    it('leaves a paste on a free spot where it was asked to go', async () => {
      const { result } = renderHook(() => useNodeCreation('p1', 's1'));
      const [pasted] = (await result.current.pastePayload(
        payloadOf([{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} }]),
        { dx: 24, dy: 24 },
      )) ?? [];
      expect(placed([pasted as string])).toEqual([{ x: 24, y: 24 }]);
    });
  });

  // Read back through the real document rather than a mocked `addNode`: the
  // mode, the model and the wiring are written by later calls, so a test that
  // only watched the create call would see none of them and stay green with
  // the group placed unconfigured and unwired.
  describe('placeProposalAt', () => {
    /**
     * The view of a placed node, narrowed to the content kind it must be.
     * @param nodes - Everything the document holds.
     * @param id - The node to find.
     * @returns Its content view.
     */
    const contentAt = (
      nodes: ReadonlyArray<canvasSpace.CanvasNodeView>,
      id: string | undefined,
    ): ContentNodeView => {
      const found = nodes.find((n) => n.id === id);
      if (!found || found.type === 'annotation' || found.type === 'group') {
        throw new Error(`no content node placed at ${String(id)}`);
      }
      return found.data;
    };

    /** An accepted proposal: an empty node feeding one generation node. */
    const PAIR: CanvasProposal = {
      nodes: [
        { role: 'source', type: 'image', name: 'Your product photo' },
        {
          role: 'generate',
          type: 'image',
          name: 'On white',
          mode: 'i2i',
          model: 'some-model',
          takesPrompt: true,
          params: { ratio: '1:1' },
          prompt: [{ text: 'white ground' }],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      modelNote: '',
      rationale: '',
      groupName: 'On a white ground',
    };

    it('places what feeds the generation to its left, wired the way it was proposed', () => {
      const { result } = renderHook(() => useNodeCreation('p-prop', 's-prop'));

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);

      const { nodes, edges } = canvasSpace.readCanvasGraph('p-prop', 's-prop');
      expect(ids).toHaveLength(2);
      expect(contentAt(nodes, ids[0]).name).toBe('Your product photo');
      expect(contentAt(nodes, ids[1]).name).toBe('On white');
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const source = byId.get(ids[0]!)!;
      const generate = byId.get(ids[1]!)!;
      // One row, stepping right: same y, and the second sits a step along.
      expect(source.position.y).toBe(generate.position.y);
      expect(generate.position.x - source.position.x).toBe(360);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ source: ids[0], target: ids[1] });
    });

    it('fills in the mode, model and parameters the proposal chose', () => {
      const { result } = renderHook(() => useNodeCreation('p-cfg', 's-cfg'));

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);

      const { nodes } = canvasSpace.readCanvasGraph('p-cfg', 's-cfg');
      const generate = contentAt(nodes, ids[1]);
      expect(generate.mode).toBe('i2i');
      expect(generate.model).toBe('some-model');
      expect(generate.paramsByModel).toEqual({ 'some-model': { ratio: '1:1' } });
    });

    it('puts the prompt in the generation node, @-ing the pooled node for the reader (inner#1315)', () => {
      const withRef: CanvasProposal = {
        ...PAIR,
        nodes: [PAIR.nodes[0]!, { ...PAIR.nodes[1]!, prompt: [{ text: 'white ground, ' }, { ref: 0 }] }],
      };
      const { result } = renderHook(() => useNodeCreation('p-pr', 's-pr'));

      const { nodeIds: ids } = result.current.placeProposalAt(withRef, { x: 0, y: 0 }, []);

      const written = canvasSpace.getPromptFragment('p-pr', 's-pr', ids[1]!, 'i2i')!.toJSON();
      expect(written).toContain('white ground, ');
      expect(written).toContain(`sourceNodeId="${ids[0]!}"`);
      expect(written).toContain('label="Your product photo"');
      expect(written).toContain('kind="image"');
      expect(written).not.toContain('thumbnail=');
    });

    it('shows a material clip\'s cover on the chip that @s it', () => {
      const CLIP = 'https://ours.example/video/clip.mp4';
      const COVER = 'https://ours.example/video/clip.jpg';
      const held: CanvasProposal = {
        nodes: [
          { role: 'source', type: 'video', name: 'Clip', material: CLIP, materialMedia: { mimeType: 'video/mp4', width: 10, height: 10, coverUrl: COVER, duration: 3, size: 1 } },
          { role: 'generate', type: 'video', name: 'Remix', mode: 'ref', model: 'some-model', takesPrompt: true, prompt: [{ text: 'restyle ' }, { ref: 0 }] },
        ],
        edges: [{ fromIndex: 0, toIndex: 1, into: 'pool' }],
        rationale: '',
        groupName: 'Remix',
      };
      const { result } = renderHook(() => useNodeCreation('p-cover', 's-cover'));

      const { nodeIds: ids } = result.current.placeProposalAt(held, { x: 0, y: 0 }, []);

      expect(canvasSpace.getPromptFragment('p-cover', 's-cover', ids[1]!, 'ref')!.toJSON()).toContain(`thumbnail="${COVER}"`);
    });

    it('shows a material picture on the chip that @s it', () => {
      const PHOTO = 'https://ours.example/image/photo.png';
      const held: CanvasProposal = {
        ...PAIR,
        nodes: [
          { ...PAIR.nodes[0]!, material: PHOTO, materialMedia: { mimeType: 'image/png', width: 10, height: 10, coverUrl: null, duration: null, size: 1 } },
          { ...PAIR.nodes[1]!, prompt: [{ text: 'repaint ' }, { ref: 0 }] },
        ],
      };
      const { result } = renderHook(() => useNodeCreation('p-thumb', 's-thumb'));

      const { nodeIds: ids } = result.current.placeProposalAt(held, { x: 0, y: 0 }, []);

      expect(canvasSpace.getPromptFragment('p-thumb', 's-thumb', ids[1]!, 'i2i')!.toJSON()).toContain(`thumbnail="${PHOTO}"`);
    });

    it('puts each text node @\'d in a song model\'s lyrics box on a line of its own', () => {
      const song: CanvasProposal = {
        nodes: [
          { role: 'written', type: 'text', name: 'Verse', prompt: [{ text: 'la la' }] },
          { role: 'written', type: 'text', name: 'Chorus', prompt: [{ text: 'oh oh' }] },
          { role: 'generate', type: 'audio', name: 'Song', mode: 't2m', model: 'some-model', takesPrompt: true, prompt: [{ text: 'gentle pop' }] },
        ],
        edges: [
          { fromIndex: 0, toIndex: 2, into: 'lyrics' },
          { fromIndex: 1, toIndex: 2, into: 'lyrics' },
        ],
        rationale: '',
        groupName: 'Song',
      };
      const { result } = renderHook(() => useNodeCreation('p-lyr2', 's-lyr2'));

      const { nodeIds: ids } = result.current.placeProposalAt(song, { x: 0, y: 0 }, []);

      const box = canvasSpace.getLyricsFragment('p-lyr2', 's-lyr2', ids[2]!, 't2m')!;
      const lines = box.toArray().map((line) => (line as Y.XmlElement).toString());
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(`sourceNodeId="${ids[0]!}"`);
      expect(lines[1]).toContain(`sourceNodeId="${ids[1]!}"`);
    });

    it('@s a text node in a song model\'s lyrics box, and not in its prompt', () => {
      const song: CanvasProposal = {
        nodes: [
          { role: 'written', type: 'text', name: 'Lyrics', prompt: [{ text: 'la la la' }] },
          { role: 'generate', type: 'audio', name: 'Song', mode: 't2m', model: 'some-model', takesPrompt: true, prompt: [{ text: 'gentle pop' }] },
        ],
        edges: [{ fromIndex: 0, toIndex: 1, into: 'lyrics' }],
        rationale: '',
        groupName: 'Song',
      };
      const { result } = renderHook(() => useNodeCreation('p-lyr', 's-lyr'));

      const { nodeIds: ids } = result.current.placeProposalAt(song, { x: 0, y: 0 }, []);

      expect(canvasSpace.getLyricsFragment('p-lyr', 's-lyr', ids[1]!, 't2m')!.toJSON()).toContain(`sourceNodeId="${ids[0]!}"`);
      expect(canvasSpace.getPromptFragment('p-lyr', 's-lyr', ids[1]!, 't2m')!.toJSON()).not.toContain('sourceNodeId');
    });

    it('records the model as a choice, so switching mode and back keeps it', () => {
      // The agent picked this model on the reader's behalf, which is a pick
      // like any other. Written as a mode switch it would be forgotten the
      // moment the reader looked at another mode.
      const { result } = renderHook(() => useNodeCreation('p-mm', 's-mm'));

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);

      const { nodes } = canvasSpace.readCanvasGraph('p-mm', 's-mm');
      const generate = contentAt(nodes, ids[1]);
      expect(generate.modelByMode).toEqual({ i2i: 'some-model' });
    });

    it('writes the prompt into the mode the proposal chose, and no other (#2218)', () => {
      const { result } = renderHook(() => useNodeCreation('p-mode', 's-mode'));
      const withWords: CanvasProposal = {
        ...PAIR,
        nodes: [PAIR.nodes[0]!, { ...PAIR.nodes[1]!, prompt: [{ text: 'a red boat' }] }],
      };

      const { nodeIds: ids } = result.current.placeProposalAt(withWords, { x: 0, y: 0 }, []);

      expect(canvasSpace.getPromptFragment('p-mode', 's-mode', ids[1]!, 'i2i')!.toJSON()).toContain('a red boat');
      expect(canvasSpace.getPromptFragment('p-mode', 's-mode', ids[1]!, 't2i')!.toJSON()).not.toContain('a red boat');
    });

    it('lands proposed shots on the node, each @-ing the node it names', () => {
      const shots: CanvasProposal = {
        nodes: [
          { role: 'source', type: 'image', name: 'Hero' },
          { role: 'source', type: 'image', name: 'Extra' },
          {
            role: 'generate', type: 'video', name: 'Clip', mode: 'multi_shot', model: 'some-model',
            takesPrompt: true,
            shots: [
              { prompt: [{ text: 'first ' }, { ref: 0 }], duration: 2 },
              { prompt: [{ text: 'then ' }, { ref: 1 }], duration: 3 },
            ],
          },
        ],
        edges: [{ fromIndex: 0, toIndex: 2 }, { fromIndex: 1, toIndex: 2 }],
        rationale: '',
        groupName: 'Shots',
      };
      const { result } = renderHook(() => useNodeCreation('p-shot', 's-shot'));

      const { nodeIds: ids } = result.current.placeProposalAt(shots, { x: 0, y: 0 }, []);

      const landed = readShots('p-shot', 's-shot', ids[2]!);
      expect(landed?.map((shot) => shot.duration)).toEqual([2, 3]);
      expect(landed?.[0]?.prompt.toJSON()).toContain(`sourceNodeId="${ids[0]!}"`);
      expect(landed?.[1]?.prompt.toJSON()).toContain(`sourceNodeId="${ids[1]!}"`);
    });

    describe('reminding the reader to edit the marked parts (inner#977)', () => {
      beforeEach(() => {
        vi.mocked(toast.info).mockClear();
      });

      it('reminds them when a placed prompt carries a mark to fill', () => {
        const marked: CanvasProposal = {
          ...PAIR,
          nodes: [
            PAIR.nodes[0]!,
            { ...PAIR.nodes[1]!, prompt: [{ slot: { kind: 'tweak', label: 'the mood', note: '' } }] },
          ],
        };
        const { result } = renderHook(() => useNodeCreation('p-mk', 's-mk'));
        result.current.placeProposalAt(marked, { x: 0, y: 0 }, []);
        // A proposal lands no square brackets: its references arrive as
        // mentions, so the reminder speaks of the braces alone.
        expect(toast.info).toHaveBeenCalledWith(en.canvas.generatePanel.editProposalMarks);
      });

      it('reminds them when only a shot carries a mark', () => {
        const shot: CanvasProposal = {
          nodes: [
            {
              role: 'generate', type: 'video', name: 'Clip', mode: 'multi_shot', model: 'some-model',
              takesPrompt: true,
              shots: [{ prompt: [{ text: 'a ' }, { slot: { kind: 'tweak', label: 'scene', note: '' } }], duration: 2 }],
            },
          ],
          edges: [],
          rationale: '',
          groupName: 'Clip',
        };
        const { result } = renderHook(() => useNodeCreation('p-mks', 's-mks'));
        result.current.placeProposalAt(shot, { x: 0, y: 0 }, []);
        expect(toast.info).toHaveBeenCalledTimes(1);
      });

      it('says nothing, and writes nothing, where the model draws no prompt box', () => {
        const boxless: CanvasProposal = {
          ...PAIR,
          nodes: [
            PAIR.nodes[0]!,
            {
              ...PAIR.nodes[1]!,
              takesPrompt: false,
              prompt: [{ slot: { kind: 'note', label: 'Pick the photo in the panel' } }],
            },
          ],
        };
        const { result } = renderHook(() => useNodeCreation('p-box', 's-box'));
        const { nodeIds: ids } = result.current.placeProposalAt(boxless, { x: 0, y: 0 }, []);
        expect(toast.info).not.toHaveBeenCalled();
        expect(canvasSpace.getPromptFragment('p-box', 's-box', ids[1]!, 'i2i')!.toJSON()).not.toContain('Pick the photo');
      });

      it('says nothing when a placed prompt carries only a note, which shows in the box already', () => {
        const noted: CanvasProposal = {
          ...PAIR,
          nodes: [
            PAIR.nodes[0]!,
            { ...PAIR.nodes[1]!, prompt: [{ slot: { kind: 'note', label: 'Pick it in the panel' } }, { text: 'white' }] },
          ],
        };
        const { result } = renderHook(() => useNodeCreation('p-nt', 's-nt'));
        result.current.placeProposalAt(noted, { x: 0, y: 0 }, []);
        expect(toast.info).not.toHaveBeenCalled();
      });

      it('says nothing when the prompt only @s a node', () => {
        const atOnly: CanvasProposal = {
          ...PAIR,
          nodes: [PAIR.nodes[0]!, { ...PAIR.nodes[1]!, prompt: [{ text: 'repaint ' }, { ref: 0 }] }],
        };
        const { result } = renderHook(() => useNodeCreation('p-atonly', 's-atonly'));
        result.current.placeProposalAt(atOnly, { x: 0, y: 0 }, []);
        expect(toast.info).not.toHaveBeenCalled();
      });

      it('says nothing when the prompts are plain words', () => {
        const { result } = renderHook(() => useNodeCreation('p-plain', 's-plain'));
        result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);
        expect(toast.info).not.toHaveBeenCalled();
      });
    });

    describe('the material a reader gave, landed and filled into slots (inner#1315)', () => {
      const PORTRAIT = 'https://ours.example/image/face.png';
      const VOICE = 'https://ours.example/audio/voice.mp3';
      const TALKING: CanvasProposal = {
        nodes: [
          {
            role: 'source',
            type: 'image',
            name: 'Your portrait',
            material: PORTRAIT,
            materialMedia: { coverUrl: null, width: 800, height: 600, duration: null, mimeType: 'image/png', size: 10 },
          },
          {
            role: 'source',
            type: 'audio',
            name: 'Your voice',
            material: VOICE,
            materialMedia: { coverUrl: null, width: null, height: null, duration: 3, mimeType: 'audio/mpeg', size: 20 },
          },
          {
            role: 'generate',
            type: 'video',
            name: 'Talking head',
            mode: 'talking_head',
            model: 'a-talker',
            takesPrompt: false,
            fills: { image: [0], audio: [1] },
          },
        ],
        edges: [],
        rationale: '',
      };

      it('lands each material node holding the file and the numbers an upload gives it', () => {
        const { result } = renderHook(() => useNodeCreation('p-mat', 's-mat'));

        const { nodeIds: ids } = result.current.placeProposalAt(TALKING, { x: 0, y: 0 }, []);

        const { nodes } = canvasSpace.readCanvasGraph('p-mat', 's-mat');
        const portrait = contentAt(nodes, ids[0]);
        const voice = contentAt(nodes, ids[1]);
        expect(nodes.find((n) => n.id === ids[0])?.type).toBe('image');
        expect(nodes.find((n) => n.id === ids[1])?.type).toBe('audio');
        expect(portrait).toMatchObject({ content: PORTRAIT, width: 800, height: 600 });
        expect(voice).toMatchObject({ content: VOICE, duration: 3 });
      });

      it('fills the talking head the way picks in its panel would, with no wire drawn', () => {
        const { result } = renderHook(() => useNodeCreation('p-fill', 's-fill'));

        const { nodeIds: ids } = result.current.placeProposalAt(TALKING, { x: 0, y: 0 }, []);

        const { nodes, edges } = canvasSpace.readCanvasGraph('p-fill', 's-fill');
        const head = contentAt(nodes, ids[2]);
        // The portrait is the character, not a first frame: both slots send
        // `image`, and only the mode's row says which one this is.
        expect(head.characterImageUrl).toBe(PORTRAIT);
        expect(head.firstFrameUrl).toBeUndefined();
        expect(head.drivingAudio).toEqual({ url: VOICE, duration: 3 });
        expect(edges).toHaveLength(0);
      });

      it('lists every picture filling a slot that holds several', () => {
        const styled: CanvasProposal = {
          nodes: [
            { ...TALKING.nodes[0]! },
            { ...TALKING.nodes[0]!, name: 'Second look', material: 'https://ours.example/image/b.png' },
            {
              role: 'generate',
              type: 'image',
              name: 'In that style',
              mode: 't2i',
              model: 'a-painter',
              takesPrompt: true,
              prompt: [{ text: 'a teapot' }],
              fills: { style_images: [0, 1] },
            },
          ],
          edges: [],
          rationale: '',
        };
        const { result } = renderHook(() => useNodeCreation('p-style', 's-style'));

        const { nodeIds: ids } = result.current.placeProposalAt(styled, { x: 0, y: 0 }, []);

        const { nodes } = canvasSpace.readCanvasGraph('p-style', 's-style');
        expect(contentAt(nodes, ids[2]).styleImageUrls).toEqual([PORTRAIT, 'https://ours.example/image/b.png']);
      });

      it('fills a sound effect from a clip, carrying its poster and length the way a pick does', () => {
        const CLIP = 'https://ours.example/video/clip.mp4';
        const POSTER = 'https://ours.example/image/clip-cover.png';
        const scored: CanvasProposal = {
          nodes: [
            {
              role: 'source',
              type: 'video',
              name: 'Your clip',
              material: CLIP,
              materialMedia: { coverUrl: POSTER, width: 1280, height: 720, duration: 6, mimeType: 'video/mp4', size: 30 },
            },
            {
              role: 'generate',
              type: 'audio',
              name: 'Its sound',
              mode: 'sfx',
              model: 'a-sounder',
              takesPrompt: true,
              prompt: [{ text: 'footsteps' }],
              fills: { video: [0] },
            },
          ],
          edges: [],
          rationale: '',
        };
        const { result } = renderHook(() => useNodeCreation('p-sfx', 's-sfx'));

        const { nodeIds: ids } = result.current.placeProposalAt(scored, { x: 0, y: 0 }, []);

        const { nodes } = canvasSpace.readCanvasGraph('p-sfx', 's-sfx');
        expect(nodes.find((n) => n.id === ids[0])?.type).toBe('video');
        expect(contentAt(nodes, ids[0])).toMatchObject({ content: CLIP, coverUrl: POSTER });
        expect(contentAt(nodes, ids[1]).soundVideo).toEqual({ url: CLIP, cover: POSTER, duration: 6 });
      });

      it('goes down as one undo entry with the material and the fills in it', () => {
        const undo = canvasSpace.createCanvasUndoManager(
          getDoc(docName.canvasSpace('p-mundo', 's-mundo')),
        );
        const { result } = renderHook(() => useNodeCreation('p-mundo', 's-mundo'));

        const { nodeIds: ids } = result.current.placeProposalAt(TALKING, { x: 0, y: 0 }, []);
        expect(undo.undoStack).toHaveLength(1);
        undo.undo();
        undo.redo();

        // Redone, the nodes come back holding what they were placed with.
        const { nodes } = canvasSpace.readCanvasGraph('p-mundo', 's-mundo');
        expect(contentAt(nodes, ids[0])).toMatchObject({ content: PORTRAIT });
        expect(contentAt(nodes, ids[2]).characterImageUrl).toBe(PORTRAIT);
      });
    });

    it('leaves the source node without a mode or a model', () => {
      const { result } = renderHook(() => useNodeCreation('p-src', 's-src'));

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);

      const { nodes } = canvasSpace.readCanvasGraph('p-src', 's-src');
      expect(contentAt(nodes, ids[0]).model).toBeUndefined();
    });

    it('goes down as one undo entry, and one undo takes the whole group back', () => {
      // The manager is built before the press so it captures it. It tracks
      // only `CANVAS_UNDO` transactions and merges nothing by time
      // (`captureTimeout: 0`), so every write outside one batch would arrive
      // as an entry of its own -- which is what makes the count below mean
      // "one press, one entry" rather than "something was written".
      const undo = canvasSpace.createCanvasUndoManager(
        getDoc(docName.canvasSpace('p-undo', 's-undo')),
      );
      const { result } = renderHook(() => useNodeCreation('p-undo', 's-undo'));

      result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);

      expect(undo.undoStack).toHaveLength(1);
      const placed = canvasSpace.readCanvasGraph('p-undo', 's-undo');
      // The two nodes and the group holding them.
      expect(placed.nodes).toHaveLength(3);
      expect(placed.edges).toHaveLength(1);

      undo.undo();

      // Nodes, group AND wires, all gone. A flow that undoes down to a lone
      // wire, a stray empty node or an empty group is the half-placed state
      // the batch exists to rule out.
      const after = canvasSpace.readCanvasGraph('p-undo', 's-undo');
      expect(after.nodes).toHaveLength(0);
      expect(after.edges).toHaveLength(0);
    });

    it('leaves ordinary nodes behind: the model swaps and the group wires on', () => {
      // What lands is the canvas's own kind of node, not a special one the
      // agent owns -- so the reader changes the model the agent picked and
      // wires the result into something of their own, both the ordinary way.
      const { result } = renderHook(() => useNodeCreation('p-after', 's-after'));
      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);
      const generated = ids[1]!;

      canvasSpace.setNodeModel('p-after', 's-after', generated, 'i2i', 'their-model', {
        'their-model': { ratio: '16:9' },
      });
      const mine = result.current.createNodeAt('image', { x: 900, y: 0 });
      canvasSpace.addEdge('p-after', 's-after', {
        id: `${generated}->${mine}`,
        source: generated,
        target: mine,
      });

      const { nodes, edges } = canvasSpace.readCanvasGraph('p-after', 's-after');
      const after = contentAt(nodes, generated);
      expect(after.model).toBe('their-model');
      expect(after.paramsByModel).toMatchObject({ 'their-model': { ratio: '16:9' } });
      expect(edges.map((e) => `${e.source}->${e.target}`)).toContain(
        `${generated}->${mine}`,
      );
    });

    it('lands the nodes exactly where the arrangement put them', () => {
      // `createNodeAt` centres a node on the point it is given, so the
      // arrangement's top-left has to be handed over as a centre. Without
      // that offset an eleven-line note sits a hundred pixels below where the
      // group was drawn around it -- and the group is drawn from these rects.
      const { result } = renderHook(() => useNodeCreation('p-pos', 's-pos'));

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 700, y: 400 }, []);

      const wanted = planFlowLayout(PAIR, { x: 700, y: 400 });
      const { nodes } = canvasSpace.readCanvasGraph('p-pos', 's-pos');
      const byId = new Map(nodes.map((n) => [n.id, n]));
      ids.forEach((id, i) => {
        const at = wanted[i];
        const node = byId.get(id);
        if (!at || !node) throw new Error('nothing was placed');
        // Members of a group store their position relative to it.
        const group = node.parentId ? byId.get(node.parentId) : undefined;
        expect({
          x: node.position.x + (group?.position.x ?? 0),
          y: node.position.y + (group?.position.y ?? 0),
        }).toEqual({ x: at.x, y: at.y });
      });
    });

    it('writes a node that already holds its words into its body', () => {
      const withCopy: CanvasProposal = {
        nodes: [
          {
            role: 'written',
            type: 'text',
            name: 'Your copy',
            prompt: [
              { text: 'A pour-over kettle, ' },
              { slot: { kind: 'tweak', label: 'your brand', note: 'put yours here' } },
              { text: ', slow and warm.' },
            ],
          },
        ],
        edges: [],
        rationale: '',
      };
      const { result } = renderHook(() => useNodeCreation('p-copy', 's-copy'));

      const { nodeIds } = result.current.placeProposalAt(withCopy, { x: 0, y: 0 }, []);

      const body = canvasSpace.getTextBody('p-copy', 's-copy', nodeIds[0]!);
      expect(body).not.toBeNull();
      // The braces stay in the words: they are what says which part is still
      // theirs to rewrite (#263 A16, inner#977).
      expect(bodyToPlainText(body!)).toBe(
        'A pour-over kettle, {✏️ your brand}, slow and warm.',
      );
    });

    it('puts two or more nodes inside a group the model named', () => {
      const { result } = renderHook(() => useNodeCreation('p-grp', 's-grp'));

      const { nodeIds, groupId } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);

      expect(groupId).toBeDefined();
      const { nodes } = canvasSpace.readCanvasGraph('p-grp', 's-grp');
      const group = nodes.find((n) => n.id === groupId);
      if (!group || group.type !== 'group') throw new Error('no group was placed');
      expect(group.data.name).toBe('On a white ground');
      // A ground of its own, so the whole thing reads as one piece of work.
      expect(group.data.backgroundColor).toBeTruthy();
      expect(nodes.filter((n) => n.parentId === groupId).map((n) => n.id).sort()).toEqual(
        [...nodeIds].sort(),
      );
    });

    it.each([0, 0.99])('grounds the group on the tint a roll of %s picks', (roll) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(roll);
      const { result } = renderHook(() => useNodeCreation(`p-roll-${roll}`, 's-roll'));

      const { groupId } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);
      random.mockRestore();

      const group = canvasSpace
        .readCanvasGraph(`p-roll-${roll}`, 's-roll')
        .nodes.find((n) => n.id === groupId);
      if (!group || group.type !== 'group') throw new Error('no group was placed');
      expect(group.data.backgroundColor).toBe(groupBackgroundFor(roll));
    });

    it('draws the group tall enough for the words inside it', () => {
      // The group is built from the arrangement's rects, and those are as tall
      // as the words wrap to. Built from the standard footprint instead, an
      // eleven-line note would hang out of the bottom of its own group.
      const long: CanvasProposal = {
        nodes: [
          {
            role: 'written',
            type: 'text',
            name: 'Your copy',
            prompt: [{ text: 'A pour-over kettle, slow and warm.\n'.repeat(11) }],
          },
          { role: 'source', type: 'image', name: 'Your photo' },
          PAIR.nodes[1]!,
        ],
        edges: [{ fromIndex: 1, toIndex: 2 }],
        modelNote: '',
        rationale: '',
        groupName: 'Copy and a picture',
      };
      const { result } = renderHook(() => useNodeCreation('p-tall', 's-tall'));

      const { nodeIds, groupId } = result.current.placeProposalAt(long, { x: 0, y: 0 }, []);

      const { nodes } = canvasSpace.readCanvasGraph('p-tall', 's-tall');
      const group = nodes.find((n) => n.id === groupId);
      if (!group || group.type !== 'group') throw new Error('no group was placed');
      const wanted = planFlowLayout(long, { x: 0, y: 0 });
      const lowest = Math.max(...wanted.map((p) => p.y + p.height));
      expect(group.position.y + (group.data.height ?? 0)).toBeGreaterThanOrEqual(lowest);
      expect(nodeIds).toHaveLength(3);
    });

    it('wraps the nodes it placed, and nothing that was already there', () => {
      const { result } = renderHook(() => useNodeCreation('p-wrap', 's-wrap'));
      const stranger = result.current.createNodeAt('image', { x: 0, y: 0 });

      const { groupId } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);

      const { nodes } = canvasSpace.readCanvasGraph('p-wrap', 's-wrap');
      expect(nodes.find((n) => n.id === stranger)?.parentId).toBeUndefined();
      expect(groupId).toBeDefined();
    });

    it('places one node on its own, with no group around it', () => {
      const alone: CanvasProposal = {
        nodes: [{ role: 'written', type: 'text', name: 'Your copy', prompt: [{ text: 'hi' }] }],
        edges: [],
        rationale: '',
      };
      const { result } = renderHook(() => useNodeCreation('p-one', 's-one'));

      const { nodeIds, groupId } = result.current.placeProposalAt(alone, { x: 0, y: 0 }, []);

      expect(groupId).toBeUndefined();
      const { nodes } = canvasSpace.readCanvasGraph('p-one', 's-one');
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.id).toBe(nodeIds[0]);
    });

    /**
     * Where each group on a Space sits and how big it is.
     * @param projectId - The project.
     * @param spaceId - The Space.
     * @returns One rect per group.
     */
    const groupRects = (projectId: string, spaceId: string): Array<{ x: number; y: number; width: number; height: number }> =>
      canvasSpace
        .readNodePlacements(projectId, spaceId)
        .filter((p) => p.type === 'group')
        .map((p) => ({ x: p.x, y: p.y, width: p.width ?? 0, height: p.height ?? 0 }));

    it('moves the whole flow right, past a node on its spot, keeping its rows', () => {
      const start = { x: 0, y: 0 };
      const planned = groupRectForMembers(planFlowLayout(PAIR, start))!;
      const taken = { x: planned.x, y: planned.y, width: 100, height: 100 };
      const { result } = renderHook(() => useNodeCreation('p-clear', 's-clear'));

      result.current.placeProposalAt(PAIR, start, [taken]);

      const [group] = groupRects('p-clear', 's-clear');
      expect(group?.x).toBe(taken.x + taken.width + ROW_GAP_PX);
      expect(group?.y).toBe(planned.y);
    });

    it('moves a single node right by its own rect, with no group padding', () => {
      const one: CanvasProposal = {
        nodes: [{ role: 'source', type: 'image', name: 'Your photo' }],
        edges: [],
        rationale: '',
      };
      const start = { x: 0, y: 0 };
      const [spot] = planFlowLayout(one, start);
      const taken = { x: spot!.x, y: spot!.y, width: 100, height: 100 };
      const { result } = renderHook(() => useNodeCreation('p-single', 's-single'));

      result.current.placeProposalAt(one, start, [taken]);

      const [placed] = canvasSpace.readNodePlacements('p-single', 's-single');
      expect(placed?.x).toBe(taken.x + taken.width + ROW_GAP_PX);
      expect(placed?.y).toBe(spot!.y);
    });

    it('reports where the batch landed, as the rect the camera frames', () => {
      const start = { x: 0, y: 0 };
      const planned = groupRectForMembers(planFlowLayout(PAIR, start))!;
      const taken = { x: planned.x, y: planned.y, width: 100, height: 100 };
      const { result } = renderHook(() => useNodeCreation('p-bounds', 's-bounds'));

      const { bounds } = result.current.placeProposalAt(PAIR, start, [taken]);

      const [group] = groupRects('p-bounds', 's-bounds');
      expect(bounds).toEqual(group);
    });

    it('reports a single node by its own rect', () => {
      const one: CanvasProposal = {
        nodes: [{ role: 'source', type: 'image', name: 'Your photo' }],
        edges: [],
        rationale: '',
      };
      const [spot] = planFlowLayout(one, { x: 0, y: 0 });
      const { result } = renderHook(() => useNodeCreation('p-bounds-one', 's-bounds-one'));

      const { bounds } = result.current.placeProposalAt(one, { x: 0, y: 0 }, []);

      expect(bounds).toEqual(spot);
    });

    it('leaves nothing on the canvas when a write fails part way', () => {
      // A prompt mark of a kind this build has no form for makes the prompt
      // write throw after the nodes and the group are in; the product never
      // hands one in any more (stored ones show as expired), so it stands in
      // for any write that fails part way.
      const stale = {
        nodes: [
          { role: 'generate', type: 'image', name: 'Reference', mode: 't2i', model: 'some-model', takesPrompt: true, prompt: [{ text: 'a girl' }] },
          {
            role: 'generate',
            type: 'image',
            name: 'Turnaround',
            mode: 'i2i',
            model: 'some-model',
            takesPrompt: true,
            prompt: [{ text: 'from ' }, { slot: { kind: 'ref', label: 'Reference', note: 'step one' } }],
          },
        ],
        edges: [{ fromIndex: 0, toIndex: 1 }],
        rationale: '',
        groupName: 'Turnaround',
      } as unknown as CanvasProposal;
      const { result } = renderHook(() => useNodeCreation('p-stale', 's-stale'));

      expect(() => result.current.placeProposalAt(stale, { x: 0, y: 0 }, [])).toThrow();

      const { nodes, edges } = canvasSpace.readCanvasGraph('p-stale', 's-stale');
      expect(nodes).toHaveLength(0);
      expect(edges).toHaveLength(0);
    });

    it('leaves the undo and redo history as it was when a write fails part way', () => {
      const name = docName.canvasSpace('p-hist', 's-hist');
      const undo = canvasSpace.getCanvasUndoManager(getDoc(name), name);
      const { result } = renderHook(() => useNodeCreation('p-hist', 's-hist'));
      result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, []);
      undo.undo();
      const before = { undo: undo.undoStack.length, redo: undo.redoStack.length };
      const stale = {
        ...PAIR,
        nodes: [PAIR.nodes[0]!, { ...PAIR.nodes[1]!, prompt: [{ slot: { kind: 'ref', label: 'x', note: 'y' } }] }],
      } as unknown as CanvasProposal;

      expect(() => result.current.placeProposalAt(stale, { x: 0, y: 0 }, [])).toThrow();

      expect({ undo: undo.undoStack.length, redo: undo.redoStack.length }).toEqual(before);
      expect(before.redo).toBe(1);
    });

    it('takes back a group written before the failure, too', () => {
      vi.spyOn(canvasSpace, 'setGroupBackground').mockImplementationOnce(() => {
        throw new Error('no background');
      });
      const { result } = renderHook(() => useNodeCreation('p-grp', 's-grp'));

      expect(() => result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, [])).toThrow();

      expect(canvasSpace.readNodePlacements('p-grp', 's-grp')).toHaveLength(0);
    });

    it('keeps the depth its own task counts can reach clear below it', () => {
      const one: CanvasProposal = {
        nodes: [{ role: 'source', type: 'image', name: 'Your photo' }],
        edges: [],
        rationale: '',
      };
      const [spot] = planFlowLayout(one, { x: 0, y: 0 });
      const below = { x: spot!.x, y: spot!.y + COUNTS_COLUMN_FLOW_DEPTH + ROW_GAP_PX - 1, width: 100, height: 100 };
      const { result } = renderHook(() => useNodeCreation('p-depth', 's-depth'));

      result.current.placeProposalAt(one, { x: 0, y: 0 }, [below]);

      const [placed] = canvasSpace.readNodePlacements('p-depth', 's-depth');
      expect(placed?.x).toBe(below.x + below.width + ROW_GAP_PX);
    });

    it('keeps clear past a group only as far as its members\u2019 counts reach', () => {
      const planned = groupRectForMembers(planFlowLayout(PAIR, { x: 0, y: 0 }))!;
      const reach = COUNTS_COLUMN_FLOW_REACH - GROUP_PADDING;
      const right = { x: planned.x + planned.width + reach + ROW_GAP_PX + 1, y: planned.y, width: 100, height: 100 };
      const { result } = renderHook(() => useNodeCreation('p-greach', 's-greach'));

      result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, [right]);

      const [group] = groupRects('p-greach', 's-greach');
      expect(group?.x).toBe(planned.x);
    });

    it('keeps clear past a group as far as its members’ counts reach', () => {
      const planned = groupRectForMembers(planFlowLayout(PAIR, { x: 0, y: 0 }))!;
      const reach = COUNTS_COLUMN_FLOW_REACH - GROUP_PADDING;
      const right = { x: planned.x + planned.width + reach + ROW_GAP_PX - 1, y: planned.y, width: 100, height: 100 };
      // Clear of the group's own rect and gap: only the counts can take this spot.
      expect(right.x).toBeGreaterThan(planned.x + planned.width + ROW_GAP_PX);
      const { result } = renderHook(() => useNodeCreation('p-gright', 's-gright'));

      result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, [right]);

      const [group] = groupRects('p-gright', 's-gright');
      expect(group!.x).toBeGreaterThan(planned.x);
    });

    it('keeps clear below a group as deep as its members’ counts reach', () => {
      const spots = planFlowLayout(PAIR, { x: 0, y: 0 });
      const planned = groupRectForMembers(spots)!;
      const top = Math.min(...spots.map((s) => s.y));
      const below = { x: planned.x, y: top + COUNTS_COLUMN_FLOW_DEPTH + ROW_GAP_PX - 1, width: 100, height: 100 };
      // Clear of the group's own rect and gap: only the counts can take this spot.
      expect(below.y).toBeGreaterThan(planned.y + planned.height + ROW_GAP_PX);
      const { result } = renderHook(() => useNodeCreation('p-gdeep', 's-gdeep'));

      result.current.placeProposalAt(PAIR, { x: 0, y: 0 }, [below]);

      const [group] = groupRects('p-gdeep', 's-gdeep');
      expect(group!.x).toBeGreaterThan(planned.x);
    });

    it('keeps the room its own task counts will take clear on its right', () => {
      const one: CanvasProposal = {
        nodes: [{ role: 'source', type: 'image', name: 'Your photo' }],
        edges: [],
        rationale: '',
      };
      const [spot] = planFlowLayout(one, { x: 0, y: 0 });
      // Past the gap, but inside the reach of the counts the new node will hang off its right edge.
      const right = { x: spot!.x + spot!.width + ROW_GAP_PX + COUNTS_COLUMN_FLOW_REACH - 1, y: spot!.y, width: 100, height: 100 };
      const { result } = renderHook(() => useNodeCreation('p-reach', 's-reach'));

      result.current.placeProposalAt(one, { x: 0, y: 0 }, [right]);

      const [placed] = canvasSpace.readNodePlacements('p-reach', 's-reach');
      expect(placed?.x).toBe(right.x + right.width + ROW_GAP_PX);
    });

    it('places a second flow clear of the first one', () => {
      const start = { x: 0, y: 0 };
      const { result } = renderHook(() => useNodeCreation('p-twice', 's-twice'));

      result.current.placeProposalAt(PAIR, start, []);
      const occupied = occupiedRects(canvasSpace.readNodePlacements('p-twice', 's-twice'), () => undefined);
      result.current.placeProposalAt(PAIR, start, occupied);

      const [first, second] = groupRects('p-twice', 's-twice');
      expect(first && second).toBeTruthy();
      const apart =
        second!.x >= first!.x + first!.width ||
        first!.x >= second!.x + second!.width ||
        second!.y >= first!.y + first!.height ||
        first!.y >= second!.y + second!.height;
      expect(apart).toBe(true);
    });

    describe('landing a template around nodes already on the canvas (inner#1345)', () => {
      const GUIDE_TEXT = 'Fixture template\n1. Split the grid\n2. Upscale each cell';
      const STYLE_PATH = 'templates/fx/style.png';

      /** What the caller says about one proposal index already on the canvas. */
      type ExistingEntry = {
        nodeId: string;
        mention: ProposalMention;
        paramsByModel?: Record<string, Record<string, unknown>>;
      };

      /**
       * The anchor placeholder a template rewrites.
       * @param prompt - Its prompt.
       * @returns The proposal node.
       */
      const anchorSlot = (prompt: CanvasProposal['nodes'][number]['prompt']): CanvasProposal['nodes'][number] => ({
        role: 'generate',
        type: 'image',
        name: 'Anchor',
        mode: 'i2i',
        model: 'tpl-model',
        takesPrompt: true,
        params: { ratio: '1:1' },
        prompt,
      });

      /** The guide text node of the fixture template, pointing at index 0. */
      const GUIDE = {
        role: 'written',
        type: 'text',
        name: 'Fixture template',
        prompt: [{ text: GUIDE_TEXT }],
        templateNode: { template: 'fx', key: 'guide', anchor: 0 },
      } as unknown as CanvasProposal['nodes'][number];

      /** The fixture's upstream generate node, fed by its resource at index 2. */
      const UPSTREAM = {
        role: 'generate',
        type: 'image',
        name: 'Sketch',
        mode: 't2i',
        model: 'tpl-model',
        takesPrompt: true,
        params: {},
        prompt: [{ text: 'a sketch in ' }, { ref: 2 }],
        templateNode: { template: 'fx', key: 'up' },
      } as unknown as CanvasProposal['nodes'][number];

      /** The fixture's resource node. */
      const STYLE = {
        role: 'source',
        type: 'image',
        name: 'Style',
        resource: STYLE_PATH,
        templateNode: { template: 'fx', key: 'style' },
      } as unknown as CanvasProposal['nodes'][number];

      /**
       * A proposal out of nodes and edges.
       * @param nodes - Its nodes.
       * @param edges - Its edges.
       * @returns The proposal.
       */
      const proposalOf = (
        nodes: CanvasProposal['nodes'],
        edges: CanvasProposal['edges'] = [],
      ): CanvasProposal => ({ nodes, edges, rationale: '' });

      /**
       * Put a node on the canvas directly, the way it would already be there.
       * @param projectId - The project.
       * @param spaceId - The Space.
       * @param type - Its type.
       * @param at - Its stored position (relative to its group when it has one).
       * @param data - Data written over the empty node's.
       * @param parentId - Its group.
       * @returns Its id.
       */
      const seed = (
        projectId: string,
        spaceId: string,
        type: CreatableNodeType,
        at: { x: number; y: number },
        data: Record<string, unknown> = {},
        parentId?: string,
      ): string => {
        const node = createEmptyNode(type, at, 'u-9');
        canvasSpace.addNode(projectId, spaceId, {
          ...node,
          ...(parentId === undefined ? {} : { parentId }),
          data: { ...node.data, ...data },
        });
        return node.id;
      };

      /**
       * Put a generation node on the canvas on a model of its own.
       * @param projectId - The project.
       * @param spaceId - The Space.
       * @param at - Its stored position.
       * @param name - Its name.
       * @param parentId - Its group.
       * @returns Its id.
       */
      const seedAnchor = (
        projectId: string,
        spaceId: string,
        at: { x: number; y: number },
        name = 'My shot',
        parentId?: string,
      ): string => {
        const id = seed(projectId, spaceId, 'image', at, { name }, parentId);
        canvasSpace.setNodeMode(projectId, spaceId, id, 'i2i', 'old-model', { 'old-model': { ratio: '4:3' } });
        canvasSpace.setNodeModel(projectId, spaceId, id, 'i2i', 'old-model', { 'old-model': { ratio: '4:3' } });
        return id;
      };

      /**
       * Put a group around nodes already on the canvas.
       * @param projectId - The project.
       * @param spaceId - The Space.
       * @param rect - The group's rect.
       * @param members - Its members, at their positions inside it.
       * @param locked - Whether the group is locked.
       * @returns Its id.
       */
      const seedGroup = (
        projectId: string,
        spaceId: string,
        rect: { x: number; y: number; width: number; height: number },
        members: Array<{ id: string; position: { x: number; y: number } }>,
        locked = false,
      ): string => {
        const id = `grp-${projectId}`;
        canvasSpace.createGroup(projectId, spaceId, createGroupNode(id, { x: rect.x, y: rect.y }, rect.width, rect.height, 'u-9'), members);
        if (locked) canvasSpace.setNodeLocked(projectId, spaceId, id, true);
        return id;
      };

      /**
       * A mention of a node already on the canvas, as its rail row shows it.
       * @param nodeId - The node.
       * @param label - The name on its row.
       * @param thumbnail - The picture on its row.
       * @returns The mention.
       */
      const mentionOf = (nodeId: string, label: string, thumbnail?: string): ProposalMention => ({
        sourceNodeId: nodeId,
        label,
        kind: 'image',
        ...(thumbnail === undefined ? {} : { thumbnail }),
      });

      /**
       * Every node's absolute top-left, by id.
       * @param projectId - The project.
       * @param spaceId - The Space.
       * @returns The positions.
       */
      const absolute = (projectId: string, spaceId: string): Map<string, { x: number; y: number }> => {
        const { nodes } = canvasSpace.readCanvasGraph(projectId, spaceId);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        return new Map(
          nodes.map((n) => {
            const group = n.parentId === undefined ? undefined : byId.get(n.parentId);
            return [n.id, { x: n.position.x + (group?.position.x ?? 0), y: n.position.y + (group?.position.y ?? 0) }];
          }),
        );
      };

      /**
       * The nodes on a Space that are not in a set of ids taken earlier.
       * @param projectId - The project.
       * @param spaceId - The Space.
       * @param before - The ids that were there before.
       * @returns The new nodes.
       */
      const addedSince = (
        projectId: string,
        spaceId: string,
        before: ReadonlySet<string>,
      ): canvasSpace.CanvasNodeView[] =>
        canvasSpace.readCanvasGraph(projectId, spaceId).nodes.filter((n) => !before.has(n.id));

      /**
       * The ids on a Space now.
       * @param projectId - The project.
       * @param spaceId - The Space.
       * @returns The ids.
       */
      const idsNow = (projectId: string, spaceId: string): Set<string> =>
        new Set(canvasSpace.readCanvasGraph(projectId, spaceId).nodes.map((n) => n.id));

      /**
       * A node's template tag as its view carries it.
       * @param projectId - The project.
       * @param spaceId - The Space.
       * @param id - The node.
       * @returns The tag, or undefined.
       */
      const tagOf = (projectId: string, spaceId: string, id: string | undefined): unknown =>
        (contentAt(canvasSpace.readCanvasGraph(projectId, spaceId).nodes, id) as { templateNode?: unknown }).templateNode;

      /**
       * Whether two rects share any area.
       * @param a - One rect.
       * @param b - The other.
       * @returns True when they overlap.
       */
      const overlaps = (a: Rect, b: Rect): boolean =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

      let ingestUrl: MockInstance<typeof canvasApi.ingestUrl>;

      beforeEach(() => {
        vi.mocked(toast.error).mockClear();
        vi.mocked(toast.info).mockClear();
        ingestUrl = vi.spyOn(canvasApi, 'ingestUrl').mockResolvedValue({ task_id: 't-1' });
      });

      afterEach(() => {
        ingestUrl.mockRestore();
      });

      it('writes the template onto the existing anchor instead of placing a new node, keeping its other model records', () => {
        const anchor = seedAnchor('p-ex1', 's-ex1', { x: 1000, y: 500 });
        const paramsByModel = { 'old-model': { ratio: '4:3' }, 'tpl-model': { ratio: '1:1' } };
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex1', 's-ex1'));

        result.current.placeProposalAt(proposalOf([anchorSlot([{ text: 'template words' }])]), { x: 0, y: 0 }, [], existing);

        const { nodes } = canvasSpace.readCanvasGraph('p-ex1', 's-ex1');
        expect(nodes).toHaveLength(1);
        const view = contentAt(nodes, anchor);
        expect(view.name).toBe('My shot');
        expect(view.mode).toBe('i2i');
        expect(view.model).toBe('tpl-model');
        expect(view.paramsByModel).toEqual(paramsByModel);
        expect(canvasSpace.getPromptFragment('p-ex1', 's-ex1', anchor, 'i2i')!.toJSON()).toContain('template words');
      });

      it('@s a reused reference under the name and picture its rail row shows, and leaves the reference as it was', () => {
        const HERO = 'https://ours.example/image/hero.png';
        const anchor = seedAnchor('p-ex2', 's-ex2', { x: 1000, y: 500 });
        const input = seed('p-ex2', 's-ex2', 'image', { x: 640, y: 500 }, { name: 'Hero photo', content: HERO });
        canvasSpace.addEdge('p-ex2', 's-ex2', { id: `${input}->${anchor}`, source: input, target: anchor });
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
          [1, { nodeId: input, mention: mentionOf(input, 'Hero photo', HERO) }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex2', 's-ex2'));

        result.current.placeProposalAt(
          proposalOf([
            anchorSlot([{ text: 'pose of ' }, { ref: 1 }]),
            { role: 'source', type: 'image', name: 'character reference' },
          ]),
          { x: 0, y: 0 },
          [],
          existing,
        );

        const { nodes, edges } = canvasSpace.readCanvasGraph('p-ex2', 's-ex2');
        expect(nodes).toHaveLength(2);
        expect(edges).toHaveLength(1);
        const written = canvasSpace.getPromptFragment('p-ex2', 's-ex2', anchor, 'i2i')!.toJSON();
        expect(written).toContain(`sourceNodeId="${input}"`);
        expect(written).toContain('label="Hero photo"');
        expect(written).toContain(`thumbnail="${HERO}"`);
        const reference = contentAt(nodes, input);
        expect(reference.name).toBe('Hero photo');
        expect(reference.model).toBeUndefined();
        expect(reference.mode).toBeUndefined();
      });

      it('places a new reference right beside a top-level anchor on an empty canvas, wired and @\'d', () => {
        const anchor = seedAnchor('p-ex3', 's-ex3', { x: 1000, y: 500 });
        const before = idsNow('p-ex3', 's-ex3');
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex3', 's-ex3'));

        result.current.placeProposalAt(
          proposalOf(
            [anchorSlot([{ text: 'from ' }, { ref: 1 }]), { role: 'source', type: 'image', name: 'character reference' }],
            [{ fromIndex: 1, toIndex: 0, into: 'pool' }],
          ),
          { x: 0, y: 0 },
          [],
          existing,
        );

        const added = addedSince('p-ex3', 's-ex3', before);
        expect(added).toHaveLength(1);
        const fresh = added[0]!;
        expect(fresh.parentId).toBeUndefined();
        expect(absolute('p-ex3', 's-ex3').get(fresh.id)).toEqual({ x: 1000 - LAYER_STEP_PX, y: 500 });
        expect(canvasSpace.readCanvasGraph('p-ex3', 's-ex3').edges.map((e) => `${e.source}->${e.target}`)).toEqual([
          `${fresh.id}->${anchor}`,
        ]);
        const written = canvasSpace.getPromptFragment('p-ex3', 's-ex3', anchor, 'i2i')!.toJSON();
        expect(written).toContain(`sourceNodeId="${fresh.id}"`);
        expect(written).toContain('label="character reference"');
      });

      it('keeps the new nodes at the top level beside a top-level anchor, with no group of their own', () => {
        const anchor = seedAnchor('p-ex4', 's-ex4', { x: 1000, y: 500 });
        const before = idsNow('p-ex4', 's-ex4');
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex4', 's-ex4'));

        const placed = result.current.placeProposalAt(
          proposalOf(
            [anchorSlot([{ text: 'finish ' }, { ref: 1 }]), UPSTREAM, STYLE, GUIDE],
            [{ fromIndex: 2, toIndex: 1, into: 'pool' }, { fromIndex: 1, toIndex: 0, into: 'pool' }],
          ),
          { x: 0, y: 0 },
          [],
          existing,
        );

        const added = addedSince('p-ex4', 's-ex4', before);
        expect(added.map((n) => n.type).sort()).toEqual(['image', 'image', 'text']);
        expect(added.every((n) => n.parentId === undefined)).toBe(true);
        expect(placed.groupId).toBeUndefined();
      });

      it('moves the new nodes left, as one block, past a neighbour on the anchor\'s left', () => {
        const anchor = seedAnchor('p-ex5', 's-ex5', { x: 1000, y: 500 });
        const before = idsNow('p-ex5', 's-ex5');
        const neighbour = { x: 1000 - LAYER_STEP_PX, y: 500, width: 100, height: 100 };
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex5', 's-ex5'));

        result.current.placeProposalAt(
          proposalOf(
            [anchorSlot([{ text: 'from ' }, { ref: 1 }]), { role: 'source', type: 'image', name: 'character reference' }],
            [{ fromIndex: 1, toIndex: 0, into: 'pool' }],
          ),
          { x: 0, y: 0 },
          [neighbour],
          existing,
        );

        const [fresh] = addedSince('p-ex5', 's-ex5', before);
        const at = absolute('p-ex5', 's-ex5').get(fresh!.id)!;
        // Same row; the right edge clears the neighbour by the gap, with or
        // without the room its task counts take.
        expect(at.y).toBe(500);
        expect(at.x + EMPTY_NODE_SIZE.width + ROW_GAP_PX).toBeLessThanOrEqual(neighbour.x);
        expect(at.x + EMPTY_NODE_SIZE.width + ROW_GAP_PX + COUNTS_COLUMN_FLOW_REACH).toBeGreaterThanOrEqual(neighbour.x);
        // The anchor stays where it was.
        expect(absolute('p-ex5', 's-ex5').get(anchor)).toEqual({ x: 1000, y: 500 });
      });

      it('does not put a new node on top of a reused reference', () => {
        const anchor = seedAnchor('p-ex6', 's-ex6', { x: 1000, y: 500 });
        // Exactly where the arrangement puts the second node of the column.
        const input = seed('p-ex6', 's-ex6', 'image', { x: 1000 - LAYER_STEP_PX, y: 620 }, { name: 'Hero photo' });
        canvasSpace.addEdge('p-ex6', 's-ex6', { id: `${input}->${anchor}`, source: input, target: anchor });
        const inputRect = { x: 1000 - LAYER_STEP_PX, y: 620, ...EMPTY_NODE_SIZE };
        const before = idsNow('p-ex6', 's-ex6');
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
          [1, { nodeId: input, mention: mentionOf(input, 'Hero photo') }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex6', 's-ex6'));

        result.current.placeProposalAt(
          proposalOf(
            [
              anchorSlot([{ ref: 1 }, { text: ' and ' }, { ref: 2 }]),
              { role: 'source', type: 'image', name: 'character reference' },
              { role: 'source', type: 'image', name: 'second reference' },
            ],
            [{ fromIndex: 2, toIndex: 0, into: 'pool' }],
          ),
          { x: 0, y: 0 },
          [inputRect],
          existing,
        );

        const added = addedSince('p-ex6', 's-ex6', before);
        expect(added).toHaveLength(1);
        const at = absolute('p-ex6', 's-ex6').get(added[0]!.id)!;
        expect(overlaps({ ...at, ...EMPTY_NODE_SIZE }, inputRect)).toBe(false);
        expect(at.x + EMPTY_NODE_SIZE.width).toBeLessThanOrEqual(inputRect.x);
      });

      it('puts the guide one column left of a 9:16 anchor that already has its reference, clear of the anchor', () => {
        const anchor = seed('p-ex7', 's-ex7', 'image', { x: 1000, y: 500 }, {
          name: 'My shot',
          content: 'https://ours.example/image/tall.png',
          mediaWidth: 1080,
          mediaHeight: 1920,
        });
        const input = seed('p-ex7', 's-ex7', 'image', { x: 1000 - LAYER_STEP_PX, y: -400 }, { name: 'Hero photo' });
        canvasSpace.addEdge('p-ex7', 's-ex7', { id: `${input}->${anchor}`, source: input, target: anchor });
        const before = idsNow('p-ex7', 's-ex7');
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
          [1, { nodeId: input, mention: mentionOf(input, 'Hero photo') }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex7', 's-ex7'));

        result.current.placeProposalAt(
          proposalOf([anchorSlot([{ text: 'from ' }, { ref: 1 }]), { role: 'source', type: 'image', name: 'character reference' }, GUIDE]),
          { x: 0, y: 0 },
          [{ x: 1000 - LAYER_STEP_PX, y: -400, ...EMPTY_NODE_SIZE }],
          existing,
        );

        const added = addedSince('p-ex7', 's-ex7', before);
        expect(added).toHaveLength(1);
        const at = absolute('p-ex7', 's-ex7').get(added[0]!.id)!;
        expect(at.x).toBe(1000 - LAYER_STEP_PX);
        const anchorRect = { x: 1000, y: 500, width: EMPTY_NODE_SIZE.width, height: mediaNodeHeight(1080, 1920) };
        expect(overlaps({ ...at, width: EMPTY_NODE_SIZE.width, height: textFootprintHeight(GUIDE_TEXT) }, anchorRect)).toBe(false);
      });

      it('tags each template node it places and points the guide at the anchor node', () => {
        const anchor = seedAnchor('p-ex8', 's-ex8', { x: 1000, y: 500 });
        const before = idsNow('p-ex8', 's-ex8');
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-ex8', 's-ex8'));

        result.current.placeProposalAt(
          proposalOf(
            [anchorSlot([{ text: 'finish ' }, { ref: 1 }]), UPSTREAM, STYLE, GUIDE],
            [{ fromIndex: 2, toIndex: 1, into: 'pool' }, { fromIndex: 1, toIndex: 0, into: 'pool' }],
          ),
          { x: 0, y: 0 },
          [],
          existing,
        );

        const added = addedSince('p-ex8', 's-ex8', before);
        const byName = new Map(
          added.flatMap((n) => (n.type === 'group' || n.type === 'annotation' ? [] : [[n.data.name, n.id] as const])),
        );
        expect(tagOf('p-ex8', 's-ex8', byName.get('Sketch'))).toEqual({ template: 'fx', key: 'up' });
        expect(tagOf('p-ex8', 's-ex8', byName.get('Style'))).toEqual({ template: 'fx', key: 'style' });
        expect(tagOf('p-ex8', 's-ex8', byName.get('Fixture template'))).toEqual({ template: 'fx', key: 'guide', anchor });
        expect(tagOf('p-ex8', 's-ex8', anchor)).toBeUndefined();
        expect(bodyToPlainText(canvasSpace.getTextBody('p-ex8', 's-ex8', byName.get('Fixture template')!)!)).toBe(GUIDE_TEXT);
      });

      it('points the guide of an agent proposal at the anchor node it placed', () => {
        const { result } = renderHook(() => useNodeCreation('p-ag1', 's-ag1'));

        const { nodeIds } = result.current.placeProposalAt(
          {
            ...proposalOf(
              [anchorSlot([{ text: 'finish ' }, { ref: 1 }]), UPSTREAM, STYLE, GUIDE],
              [{ fromIndex: 2, toIndex: 1, into: 'pool' }, { fromIndex: 1, toIndex: 0, into: 'pool' }],
            ),
            groupName: 'Fixture template',
          },
          { x: 0, y: 0 },
          [],
        );

        expect(tagOf('p-ag1', 's-ag1', nodeIds[3])).toEqual({ template: 'fx', key: 'guide', anchor: nodeIds[0] });
        expect(tagOf('p-ag1', 's-ag1', nodeIds[1])).toEqual({ template: 'fx', key: 'up' });
        expect(tagOf('p-ag1', 's-ag1', nodeIds[0])).toBeUndefined();
      });

      it('stamps the edges it adds with strictly increasing createdAt, in the proposal\'s edge order', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(7000);
        const { result } = renderHook(() => useNodeCreation('p-ord', 's-ord'));

        const { nodeIds } = result.current.placeProposalAt(
          {
            ...proposalOf(
              [
                { role: 'source', type: 'image', name: 'Second' },
                { role: 'source', type: 'image', name: 'First' },
                anchorSlot([{ ref: 1 }, { text: ' and ' }, { ref: 0 }]),
              ],
              [{ fromIndex: 1, toIndex: 2, into: 'pool' }, { fromIndex: 0, toIndex: 2, into: 'pool' }],
            ),
            groupName: 'Two references',
          },
          { x: 0, y: 0 },
          [],
        );
        now.mockRestore();

        const edges = canvasSpace.readCanvasGraph('p-ord', 's-ord').edges;
        const stampOf = (source: string | undefined): number | undefined =>
          edges.find((e) => e.source === source && e.target === nodeIds[2])?.createdAt;
        const first = stampOf(nodeIds[1]);
        const second = stampOf(nodeIds[0]);
        expect(typeof first).toBe('number');
        expect(second).toBeGreaterThan(first!);
      });

      it('fetches a template resource into storage once the batch is written, and not before', () => {
        const name = docName.canvasSpace('p-res1', 's-res1');
        const undo = canvasSpace.getCanvasUndoManager(getDoc(name), name);
        const seen: Array<{ present: boolean; steps: number }> = [];
        ingestUrl.mockImplementation((body) => {
          seen.push({
            present: canvasSpace.readCanvasGraph('p-res1', 's-res1').nodes.some((n) => n.id === body.node_id),
            steps: undo.undoStack.length,
          });
          return Promise.resolve({ task_id: 't-1' });
        });
        const { result } = renderHook(() => useNodeCreation('p-res1', 's-res1'));

        const { nodeIds } = result.current.placeProposalAt(
          {
            ...proposalOf(
              [anchorSlot([{ text: 'finish ' }, { ref: 1 }]), UPSTREAM, STYLE],
              [{ fromIndex: 2, toIndex: 1, into: 'pool' }, { fromIndex: 1, toIndex: 0, into: 'pool' }],
            ),
            groupName: 'Fixture template',
          },
          { x: 0, y: 0 },
          [],
        );

        expect(ingestUrl).toHaveBeenCalledTimes(1);
        expect(ingestUrl).toHaveBeenCalledWith({
          template_resource: STYLE_PATH,
          project_id: 'p-res1',
          space_id: 's-res1',
          node_id: nodeIds[2],
        });
        expect(seen).toEqual([{ present: true, steps: 1 }]);
      });

      it('says the upload failed when the resource fetch is refused', async () => {
        ingestUrl.mockRejectedValue(new ApiException({ status: 429, message: 'slow down' }));
        const { result } = renderHook(() => useNodeCreation('p-res2', 's-res2'));

        result.current.placeProposalAt(
          { ...proposalOf([anchorSlot([{ ref: 1 }]), STYLE], [{ fromIndex: 1, toIndex: 0, into: 'pool' }]), groupName: 'Fixture' },
          { x: 0, y: 0 },
          [],
        );

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.canvas.upload.failed));
      });

      it('fetches nothing when the batch fails part way', () => {
        const stale = {
          ...proposalOf(
            [
              anchorSlot([{ text: 'from ' }, { slot: { kind: 'ref', label: 'x', note: 'y' } }] as unknown as Parameters<typeof anchorSlot>[0]),
              STYLE,
            ],
            [{ fromIndex: 1, toIndex: 0, into: 'pool' }],
          ),
          groupName: 'Fixture',
        } as unknown as CanvasProposal;
        const { result } = renderHook(() => useNodeCreation('p-res3', 's-res3'));

        expect(() => result.current.placeProposalAt(stale, { x: 0, y: 0 }, [])).toThrow();

        expect(ingestUrl).not.toHaveBeenCalled();
      });

      it('fetches again into a reused resource node that is still empty', () => {
        const anchor = seedAnchor('p-res4', 's-res4', { x: 1000, y: 500 });
        const style = seed('p-res4', 's-res4', 'image', { x: 640, y: 500 }, { name: 'Style', templateNode: { template: 'fx', key: 'style' } });
        canvasSpace.addEdge('p-res4', 's-res4', { id: `${style}->${anchor}`, source: style, target: anchor });
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
          [1, { nodeId: style, mention: mentionOf(style, 'Style') }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-res4', 's-res4'));

        result.current.placeProposalAt(proposalOf([anchorSlot([{ ref: 1 }]), STYLE]), { x: 0, y: 0 }, [], existing);

        expect(canvasSpace.readCanvasGraph('p-res4', 's-res4').nodes).toHaveLength(2);
        expect(ingestUrl).toHaveBeenCalledTimes(1);
        expect(ingestUrl).toHaveBeenCalledWith({
          template_resource: STYLE_PATH,
          project_id: 'p-res4',
          space_id: 's-res4',
          node_id: style,
        });
      });

      it('leaves a reused resource node alone when it holds its file or a fetch into it is running', () => {
        const anchor = seedAnchor('p-res5', 's-res5', { x: 1000, y: 500 });
        const held = seed('p-res5', 's-res5', 'image', { x: 640, y: 300 }, {
          name: 'Style',
          content: 'https://ours.example/image/style.png',
          templateNode: { template: 'fx', key: 'style' },
        });
        const running = seed('p-res5', 's-res5', 'image', { x: 640, y: 700 }, {
          name: 'Style two',
          taskCounts: { running: 1, done: 0, failed: 0, expired: 0 },
          templateNode: { template: 'fx', key: 'style' },
        });
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
          [1, { nodeId: held, mention: mentionOf(held, 'Style') }],
          [2, { nodeId: running, mention: mentionOf(running, 'Style two') }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-res5', 's-res5'));

        result.current.placeProposalAt(
          proposalOf([anchorSlot([{ ref: 1 }, { ref: 2 }]), STYLE, { ...STYLE, name: 'Style two' }]),
          { x: 0, y: 0 },
          [],
          existing,
        );

        expect(canvasSpace.readCanvasGraph('p-res5', 's-res5').nodes).toHaveLength(3);
        expect(ingestUrl).not.toHaveBeenCalled();
      });

      it('brings a reused upstream node back to the template and @s the resource wired only into it', () => {
        const STYLE_URL = 'https://ours.example/image/style.png';
        const anchor = seedAnchor('p-up', 's-up', { x: 1000, y: 500 });
        const up = seedAnchor('p-up', 's-up', { x: 640, y: 500 }, 'My sketch');
        const style = seed('p-up', 's-up', 'image', { x: 280, y: 500 }, {
          name: 'Style ref',
          content: STYLE_URL,
          templateNode: { template: 'fx', key: 'style' },
        });
        canvasSpace.addEdge('p-up', 's-up', { id: `${style}->${up}`, source: style, target: up });
        canvasSpace.addEdge('p-up', 's-up', { id: `${up}->${anchor}`, source: up, target: anchor });
        const upParams = { 'old-model': { ratio: '4:3' }, 'tpl-model': {} };
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
          [1, { nodeId: up, mention: mentionOf(up, 'My sketch'), paramsByModel: upParams }],
          [2, { nodeId: style, mention: mentionOf(style, 'Style ref', STYLE_URL) }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-up', 's-up'));

        result.current.placeProposalAt(
          proposalOf([anchorSlot([{ text: 'finish ' }, { ref: 1 }]), UPSTREAM, STYLE]),
          { x: 0, y: 0 },
          [],
          existing,
        );

        const { nodes, edges } = canvasSpace.readCanvasGraph('p-up', 's-up');
        expect(nodes).toHaveLength(3);
        expect(edges).toHaveLength(2);
        const upstream = contentAt(nodes, up);
        expect(upstream.name).toBe('My sketch');
        expect(upstream.mode).toBe('t2i');
        expect(upstream.model).toBe('tpl-model');
        expect(upstream.paramsByModel).toEqual(upParams);
        const written = canvasSpace.getPromptFragment('p-up', 's-up', up, 't2i')!.toJSON();
        expect(written).toContain('a sketch in ');
        expect(written).toContain(`sourceNodeId="${style}"`);
        expect(written).toContain('label="Style ref"');
        expect(contentAt(nodes, style)).toMatchObject({ name: 'Style ref', content: STYLE_URL });
        expect(ingestUrl).not.toHaveBeenCalled();
      });

      it('puts the new nodes into the anchor\'s unlocked group and grows its frame to keep the padding', () => {
        const PAD = GROUP_PADDING;
        const anchor = seedAnchor('p-grow', 's-grow', { x: PAD, y: PAD });
        const groupId = seedGroup(
          'p-grow',
          's-grow',
          { x: 0, y: 0, width: EMPTY_NODE_SIZE.width + 2 * PAD, height: EMPTY_NODE_SIZE.height + 2 * PAD },
          [{ id: anchor, position: { x: PAD, y: PAD } }],
        );
        const before = idsNow('p-grow', 's-grow');
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-grow', 's-grow'));

        result.current.placeProposalAt(
          proposalOf(
            [anchorSlot([{ text: 'from ' }, { ref: 1 }]), { role: 'source', type: 'image', name: 'character reference' }, GUIDE],
            [{ fromIndex: 1, toIndex: 0, into: 'pool' }],
          ),
          { x: 0, y: 0 },
          [],
          existing,
        );

        const added = addedSince('p-grow', 's-grow', before);
        expect(added).toHaveLength(2);
        expect(added.map((n) => n.parentId)).toEqual([groupId, groupId]);
        const abs = absolute('p-grow', 's-grow');
        expect(abs.get(anchor)).toEqual({ x: PAD, y: PAD });
        const [group] = canvasSpace.readNodePlacements('p-grow', 's-grow').filter((p) => p.type === 'group');
        const frame = { x: group!.x, y: group!.y, width: group!.width ?? 0, height: group!.height ?? 0 };
        const rects = added.map((n) => ({
          ...abs.get(n.id)!,
          width: EMPTY_NODE_SIZE.width,
          height: n.type === 'text' ? textFootprintHeight(GUIDE_TEXT) : EMPTY_NODE_SIZE.height,
        }));
        expect(frame.x).toBe(Math.min(...rects.map((r) => r.x)) - PAD);
        for (const r of rects) {
          expect(r.x).toBeGreaterThanOrEqual(frame.x + PAD);
          expect(r.y).toBeGreaterThanOrEqual(frame.y + PAD);
          expect(r.x + r.width).toBeLessThanOrEqual(frame.x + frame.width - PAD);
          expect(r.y + r.height).toBeLessThanOrEqual(frame.y + frame.height - PAD);
        }
      });

      it('applies a template that places no new node into a locked group, leaving the group as it was', () => {
        const PAD = GROUP_PADDING;
        const anchor = seedAnchor('p-lock', 's-lock', { x: PAD + LAYER_STEP_PX, y: PAD });
        const input = seed('p-lock', 's-lock', 'image', { x: PAD, y: PAD }, { name: 'Hero photo' });
        const rect = { x: 0, y: 0, width: LAYER_STEP_PX + EMPTY_NODE_SIZE.width + 2 * PAD, height: EMPTY_NODE_SIZE.height + 2 * PAD };
        seedGroup('p-lock', 's-lock', rect, [
          { id: input, position: { x: PAD, y: PAD } },
          { id: anchor, position: { x: PAD + LAYER_STEP_PX, y: PAD } },
        ], true);
        canvasSpace.addEdge('p-lock', 's-lock', { id: `${input}->${anchor}`, source: input, target: anchor });
        const placementsBefore = canvasSpace.readNodePlacements('p-lock', 's-lock');
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My shot'), paramsByModel: { 'tpl-model': { ratio: '1:1' } } }],
          [1, { nodeId: input, mention: mentionOf(input, 'Hero photo') }],
        ]);
        const { result } = renderHook(() => useNodeCreation('p-lock', 's-lock'));

        result.current.placeProposalAt(
          proposalOf([anchorSlot([{ text: 'pose of ' }, { ref: 1 }]), { role: 'source', type: 'image', name: 'character reference' }]),
          { x: 0, y: 0 },
          [],
          existing,
        );

        expect(canvasSpace.readNodePlacements('p-lock', 's-lock')).toEqual(placementsBefore);
        const view = contentAt(canvasSpace.readCanvasGraph('p-lock', 's-lock').nodes, anchor);
        expect(view.model).toBe('tpl-model');
        expect(canvasSpace.getPromptFragment('p-lock', 's-lock', anchor, 'i2i')!.toJSON()).toContain(`sourceNodeId="${input}"`);
      });

      it('takes every write back through a temporary undo manager when one fails part way, leaving no undo step', () => {
        const PAD = GROUP_PADDING;
        const name = docName.canvasSpace('p-rb', 's-rb');
        const undo = canvasSpace.getCanvasUndoManager(getDoc(name), name);
        const anchor = seed('p-rb', 's-rb', 'audio', { x: PAD, y: PAD }, { name: 'My song' });
        canvasSpace.setNodeMode('p-rb', 's-rb', anchor, 't2m', 'old-model', { 'old-model': { length: 30 } });
        canvasSpace.setNodeModel('p-rb', 's-rb', anchor, 't2m', 'old-model', { 'old-model': { length: 30 } });
        writeProposalPrompt(canvasSpace.getPromptFragment('p-rb', 's-rb', anchor, 't2m')!, [{ text: 'old prompt' }]);
        writeProposalPrompt(canvasSpace.getLyricsFragment('p-rb', 's-rb', anchor, 't2m')!, [{ text: 'old lyrics' }]);
        const cover = seed('p-rb', 's-rb', 'image', { x: -600, y: PAD }, { name: 'Cover art' });
        canvasSpace.addEdge('p-rb', 's-rb', { id: `${cover}->${anchor}`, source: cover, target: anchor });
        seedGroup(
          'p-rb',
          's-rb',
          { x: 0, y: 0, width: EMPTY_NODE_SIZE.width + 2 * PAD, height: EMPTY_NODE_SIZE.height + 2 * PAD },
          [{ id: anchor, position: { x: PAD, y: PAD } }],
        );
        const graphBefore = canvasSpace.readCanvasGraph('p-rb', 's-rb');
        const placementsBefore = canvasSpace.readNodePlacements('p-rb', 's-rb');
        const promptBefore = canvasSpace.getPromptFragment('p-rb', 's-rb', anchor, 't2m')!.toJSON();
        const lyricsBefore = canvasSpace.getLyricsFragment('p-rb', 's-rb', anchor, 't2m')!.toJSON();
        const stacks = { undo: undo.undoStack.length, redo: undo.redoStack.length };
        const existing = new Map<number, ExistingEntry>([
          [0, { nodeId: anchor, mention: mentionOf(anchor, 'My song'), paramsByModel: { 'old-model': { length: 30 }, 'tpl-model': {} } }],
        ]);
        // Growing the group is the last write of the batch, after the prompt
        // and the lyrics of the anchor have been rewritten.
        const grow = vi.spyOn(canvasSpace, 'expandGroup').mockImplementationOnce(() => {
          throw new Error('no room');
        });
        const { result } = renderHook(() => useNodeCreation('p-rb', 's-rb'));

        expect(() =>
          result.current.placeProposalAt(
            proposalOf(
              [
                { role: 'generate', type: 'audio', name: 'Song', mode: 't2m', model: 'tpl-model', takesPrompt: true, params: {}, prompt: [{ text: 'new prompt' }] },
                { role: 'written', type: 'text', name: 'Verse', prompt: [{ text: 'la la' }] },
              ],
              [{ fromIndex: 1, toIndex: 0, into: 'lyrics' }],
            ),
            { x: 0, y: 0 },
            [],
            existing,
          ),
        ).toThrow('no room');
        grow.mockRestore();

        const graphAfter = canvasSpace.readCanvasGraph('p-rb', 's-rb');
        expect(graphAfter.nodes.map((n) => n.id).sort()).toEqual(graphBefore.nodes.map((n) => n.id).sort());
        expect(graphAfter.edges.map((e) => e.id)).toEqual(graphBefore.edges.map((e) => e.id));
        const view = contentAt(graphAfter.nodes, anchor);
        expect(view.mode).toBe('t2m');
        expect(view.model).toBe('old-model');
        expect(view.paramsByModel).toEqual({ 'old-model': { length: 30 } });
        expect(canvasSpace.getPromptFragment('p-rb', 's-rb', anchor, 't2m')!.toJSON()).toBe(promptBefore);
        expect(canvasSpace.getLyricsFragment('p-rb', 's-rb', anchor, 't2m')!.toJSON()).toBe(lyricsBefore);
        expect(canvasSpace.readNodePlacements('p-rb', 's-rb')).toEqual(placementsBefore);
        expect({ undo: undo.undoStack.length, redo: undo.redoStack.length }).toEqual(stacks);
      });
    });
  });
});
