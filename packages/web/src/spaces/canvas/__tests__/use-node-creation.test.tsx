// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type * as Y from 'yjs';
import type { CanvasProposal } from '@breatic/shared';

import type { ContentNodeView, NodeView } from '@web/data/yjs/node-view';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import { useCurrentUserStore } from '@web/stores/current-user';
import { planFlowLayout } from '@web/spaces/canvas/lib/place-flow';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';

describe('useNodeCreation', () => {
  beforeEach(() => {
    // The paste case below writes into a REAL canvas document, and documents
    // are cached per name across every test file in this process.
    _resetForTests();
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

  it('pasteNodesAt clones clipboard nodes (offset + fresh ids + carried content) and returns their ids', () => {
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const ids = result.current.pasteNodesAt(
      [
        { type: 'image', position: { x: 10, y: 20 }, name: 'Hero', content: 'a.png' },
        { type: 'text', position: { x: 30, y: 40 }, content: 'note' },
      ],
      { dx: 24, dy: 24 },
    );

    expect(addNode).toHaveBeenCalledTimes(2);
    expect(ids).toHaveLength(2);
    const first = addNode.mock.calls[0][2];
    expect(first.id).toBe(ids[0]);
    expect(first.type).toBe('image');
    expect(first.position).toEqual({ x: 34, y: 44 });
    expect(first.data.content).toBe('a.png');
    // A pasted top-level clone is a root → COPY- prefixed (R2-C).
    expect(first.data.name).toBe('COPY-Hero');
    expect(first.data.createdBy).toBe('u-9');
    addNode.mockRestore();
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
      nodes: ReadonlyArray<{ id: string; data: NodeView }>,
      id: string | undefined,
    ): ContentNodeView => {
      const found = nodes.find((n) => n.id === id);
      if (!found || found.data.kind === 'annotation' || found.data.kind === 'group') {
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
          takesFrom: 'pool',
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

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 });

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

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 });

      const { nodes } = canvasSpace.readCanvasGraph('p-cfg', 's-cfg');
      const generate = contentAt(nodes, ids[1]);
      expect(generate.mode).toBe('i2i');
      expect(generate.model).toBe('some-model');
      expect(generate.paramsByModel).toEqual({ 'some-model': { ratio: '1:1' } });
    });

    it('puts the prompt in the generation node, mentioning the empty one', () => {
      const withSlot: CanvasProposal = {
        ...PAIR,
        nodes: [
          PAIR.nodes[0]!,
          {
            ...PAIR.nodes[1]!,
            prompt: [
              { text: 'white ground, ' },
              { slot: { kind: 'asset', label: 'your photo', note: 'drop it left' } },
            ],
          },
        ],
      };
      const { result } = renderHook(() => useNodeCreation('p-pr', 's-pr'));

      const { nodeIds: ids } = result.current.placeProposalAt(withSlot, { x: 0, y: 0 });

      const fragment = canvasSpace.getPromptFragment('p-pr', 's-pr', ids[1]!);
      expect(fragment).not.toBeNull();
      const written = fragment!.toJSON();
      expect(written).toContain('white ground, [📎 your photo]');
      // The mention points at the empty node this group placed, not at a name
      // or a guess -- that id is what makes the reader's file reach generation.
      expect(written).toContain(`sourceNodeId="${ids[0]}"`);
    });

    it('leaves the bracket alone where the reader picks material in the panel', () => {
      // On that path a mention picks nothing: the panel's own picker refuses
      // it (`insertRefusal`), the run reads the slot instead, and the reader
      // is left with a chip they could not have made and a slot still empty.
      // The bracket alone names the slot to pick it in.
      const bySlot: CanvasProposal = {
        ...PAIR,
        nodes: [
          PAIR.nodes[0]!,
          {
            ...PAIR.nodes[1]!,
            takesFrom: 'slot', takesPrompt: true,
            prompt: [
              { text: 'animate ' },
              { slot: { kind: 'asset', label: 'your photo', note: 'pick it in the panel' } },
            ],
          },
        ],
      };
      const { result } = renderHook(() => useNodeCreation('p-slot', 's-slot'));

      const { nodeIds: ids } = result.current.placeProposalAt(bySlot, { x: 0, y: 0 });

      const written = canvasSpace.getPromptFragment('p-slot', 's-slot', ids[1]!)!.toJSON();
      expect(written).toContain('animate [📎 your photo]');
      expect(written).not.toContain('sourceNodeId');
    });

    it('names the words upstream, not the picture, where a slot feeds it', () => {
      // Two things feed it: the step before, whose picture the reader picks
      // in the slot, and a node carrying words, whose body substitutes into
      // the prompt. The k-th mark is about the k-th node wired in, so two
      // marks are written and only the second one lands a mention -- the
      // picture keeps its place and takes none.
      const both: CanvasProposal = {
        nodes: [
          {
            role: 'generate', type: 'image', name: 'The shot', mode: 't2i',
            model: 'some-model', params: {}, takesFrom: 'slot', takesPrompt: true,
            prompt: [{ text: 'a running shoe' }],
          },
          { role: 'written', type: 'text', name: 'The caption', prompt: [{ text: 'slow and warm' }] },
          {
            role: 'generate', type: 'video', name: 'It turns', mode: 'i2v',
            model: 'some-model', params: {}, takesFrom: 'slot', takesPrompt: true,
            prompt: [
              { slot: { kind: 'ref', label: 'the shot', note: '' } },
              { text: 'in the tone of ' },
              { slot: { kind: 'ref', label: 'the caption', note: '' } },
            ],
          },
        ],
        edges: [{ fromIndex: 0, toIndex: 2 }, { fromIndex: 1, toIndex: 2 }],
        rationale: '',
        groupName: 'One spot',
      };
      const { result } = renderHook(() => useNodeCreation('p-ref', 's-ref'));

      const { nodeIds: ids } = result.current.placeProposalAt(both, { x: 0, y: 0 });

      const written = canvasSpace.getPromptFragment('p-ref', 's-ref', ids[2]!)!.toJSON();
      expect(written).toContain(`sourceNodeId="${ids[1]}"`);
      expect(written).not.toContain(`sourceNodeId="${ids[0]}"`);
    });

    it('records the model as a choice, so switching mode and back keeps it', () => {
      // The agent picked this model on the reader's behalf, which is a pick
      // like any other. Written as a mode switch it would be forgotten the
      // moment the reader looked at another mode.
      const { result } = renderHook(() => useNodeCreation('p-mm', 's-mm'));

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 });

      const { nodes } = canvasSpace.readCanvasGraph('p-mm', 's-mm');
      const generate = contentAt(nodes, ids[1]);
      expect(generate.modelByMode).toEqual({ i2i: 'some-model' });
    });

    it('mentions the empty nodes in the order they are placed, not the order they are wired', () => {
      // The k-th marked place belongs to the k-th empty node, which is what
      // the reader sees left to right. Nothing makes a model list its edges
      // in that same order, and a bracket pointing at the other node tells
      // the reader to drop their photo where the backdrop goes.
      const two: CanvasProposal = {
        nodes: [
          { role: 'source', type: 'image', name: 'Your product photo' },
          { role: 'source', type: 'image', name: 'Your backdrop' },
          {
            role: 'generate',
            type: 'image',
            name: 'Composited',
            mode: 'i2i',
            model: 'some-model',
            takesFrom: 'pool',
            takesPrompt: true,
            prompt: [
              { text: 'the product, ' },
              { slot: { kind: 'asset', label: 'your photo', note: 'drop it in the first' } },
              { text: ' on ' },
              { slot: { kind: 'asset', label: 'your backdrop', note: 'drop it in the second' } },
            ],
          },
        ],
        // Listed second-then-first, which the proposal is free to do.
        edges: [
          { fromIndex: 1, toIndex: 2 },
          { fromIndex: 0, toIndex: 2 },
        ],
        modelNote: '',
        rationale: '',
      };
      const { result } = renderHook(() => useNodeCreation('p-ord', 's-ord'));

      const { nodeIds: ids } = result.current.placeProposalAt(two, { x: 0, y: 0 });

      const written = canvasSpace.getPromptFragment('p-ord', 's-ord', ids[2]!)!.toJSON();
      const first = written.indexOf(`sourceNodeId="${ids[0]}"`);
      const second = written.indexOf(`sourceNodeId="${ids[1]}"`);
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(-1);
      expect(first).toBeLessThan(second);
    });

    it('leaves the source node without a mode or a model', () => {
      const { result } = renderHook(() => useNodeCreation('p-src', 's-src'));

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 });

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

      result.current.placeProposalAt(PAIR, { x: 0, y: 0 });

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
      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 });
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

      const { nodeIds: ids } = result.current.placeProposalAt(PAIR, { x: 700, y: 400 });

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

      const { nodeIds } = result.current.placeProposalAt(withCopy, { x: 0, y: 0 });

      const body = canvasSpace.getTextBody('p-copy', 's-copy', nodeIds[0]!);
      expect(body).not.toBeNull();
      // The bracket stays in the words: it is what says which part is still
      // theirs to rewrite (#263 A16).
      expect(bodyToPlainText(body!)).toBe(
        'A pour-over kettle, [✏️ your brand], slow and warm.',
      );
    });

    it('puts two or more nodes inside a group the model named', () => {
      const { result } = renderHook(() => useNodeCreation('p-grp', 's-grp'));

      const { nodeIds, groupId } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 });

      expect(groupId).toBeDefined();
      const { nodes } = canvasSpace.readCanvasGraph('p-grp', 's-grp');
      const group = nodes.find((n) => n.id === groupId);
      if (!group || group.data.kind !== 'group') throw new Error('no group was placed');
      expect(group.data.name).toBe('On a white ground');
      // A ground of its own, so the whole thing reads as one piece of work.
      expect(group.data.backgroundColor).toBeTruthy();
      expect(nodes.filter((n) => n.parentId === groupId).map((n) => n.id).sort()).toEqual(
        [...nodeIds].sort(),
      );
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

      const { nodeIds, groupId } = result.current.placeProposalAt(long, { x: 0, y: 0 });

      const { nodes } = canvasSpace.readCanvasGraph('p-tall', 's-tall');
      const group = nodes.find((n) => n.id === groupId);
      if (!group || group.data.kind !== 'group') throw new Error('no group was placed');
      const wanted = planFlowLayout(long, { x: 0, y: 0 });
      const lowest = Math.max(...wanted.map((p) => p.y + p.height));
      expect(group.position.y + (group.data.height ?? 0)).toBeGreaterThanOrEqual(lowest);
      expect(nodeIds).toHaveLength(3);
    });

    it('wraps the nodes it placed, and nothing that was already there', () => {
      const { result } = renderHook(() => useNodeCreation('p-wrap', 's-wrap'));
      const stranger = result.current.createNodeAt('image', { x: 0, y: 0 });

      const { groupId } = result.current.placeProposalAt(PAIR, { x: 0, y: 0 });

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

      const { nodeIds, groupId } = result.current.placeProposalAt(alone, { x: 0, y: 0 });

      expect(groupId).toBeUndefined();
      const { nodes } = canvasSpace.readCanvasGraph('p-one', 's-one');
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.id).toBe(nodeIds[0]);
    });
  });
});
