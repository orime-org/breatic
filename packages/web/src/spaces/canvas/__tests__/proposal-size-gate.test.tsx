// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 7, templates and Agent canvas
 * proposals: `placeProposalAt` writes the whole flow as one `add` batch, a
 * picked template says a refusal in a toast, and an Agent proposal reports it
 * through the card's existing outcome toast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';
import { CANVAS_NODES_KEY, type CanvasProposal } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';

import type { ExistingNode } from '@web/spaces/canvas/use-node-creation';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn((): ReturnType<typeof import('@web/data/yjs/use-socket').useSocket> => ({
    provider: null,
    synced: false,
    hasEverSynced: false,
    status: 'connecting',
    writeAccess: 'unknown',
    authFailedReason: null,
  })),
}));
vi.mock('@web/data/yjs/space-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/yjs/space-connection')>();
  const { useSocket } = await import('@web/data/yjs/use-socket');
  return { ...actual, useSpaceConnection: () => useSocket({ name: '', doc: undefined as never }) };
});

/** What the canvas hands its Generate panels; the panels themselves are not under test here. */
const panels = vi.hoisted(() => ({
  placeTemplate: null as null | ((proposal: CanvasProposal, existing: ReadonlyMap<number, ExistingNode>, order: readonly number[]) => unknown),
}));
vi.mock('@web/spaces/canvas/generate/GeneratePanelContainer', () => ({
  GeneratePanelContainer: (props: { placeTemplate: typeof panels.placeTemplate }): null => {
    panels.placeTemplate = props.placeTemplate;
    return null;
  },
}));
vi.mock('@web/spaces/canvas/generate/VideoGeneratePanelContainer', () => ({ VideoGeneratePanelContainer: (): null => null }));
vi.mock('@web/spaces/canvas/generate/AudioGeneratePanelContainer', () => ({ AudioGeneratePanelContainer: (): null => null }));

import { toast } from '@web/lib/toast';
import { modelsApi } from '@web/data/api';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import * as storyboard from '@web/data/yjs/node-storyboard';
import { readShots } from '@web/data/yjs/node-storyboard';
import { writeProposalPrompt } from '@web/spaces/canvas/generate/proposal-prompt';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { reserveSpaceRoom } from '@web/data/yjs/space-write';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { ProposalCard } from '@web/pages/project/chat/ProposalCard';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { mockSpace } from '@web/spaces/canvas/__tests__/focus-harness';
import { useCanvasStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_FULL,
  F_NORMAL,
  F_WARNING,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p-prop';
const SID = 's-prop';
const NAME = docName.canvasSpace(PID, SID);

/**
 * The proposal every case lands: a written text node whose words go into a
 * song's lyrics box, the song with its own prompt, and a multi-shot clip with
 * two shots. Lyrics exist only on audio and shots only on video, so the two
 * generation roles the spec names sit on two nodes.
 * @param songPrompt - The song's prompt text.
 * @returns The proposal.
 */
function proposalOf(songPrompt = 'gentle pop'): CanvasProposal {
  return {
    nodes: [
      { role: 'written', type: 'text', name: 'Verse', prompt: [{ text: 'la la' }] },
      { role: 'generate', type: 'audio', name: 'Song', mode: 't2m', model: 'some-model', takesPrompt: true, params: {}, prompt: [{ text: songPrompt }] },
      {
        role: 'generate', type: 'video', name: 'Clip', mode: 'multi_shot', model: 'some-model', takesPrompt: true, params: {},
        shots: [
          { prompt: [{ text: 'first shot' }], duration: 2 },
          { prompt: [{ text: 'second shot' }], duration: 3 },
        ],
      },
    ],
    edges: [{ fromIndex: 0, toIndex: 1, into: 'lyrics' }],
    rationale: 'A song and a clip',
    groupName: 'G',
  };
}

/**
 * Opens the Space and delivers one push.
 * @param push - The size push.
 * @returns The canvas document.
 */
function openAt(push: DocSizePush): Y.Doc {
  const { doc, provider } = openSizedDoc(NAME);
  pushSize(provider, push);
  return doc;
}

/**
 * Mounts the canvas, optionally beside the card that posts `proposal`.
 * @param proposal - A proposal whose card is mounted too.
 * @returns Nothing.
 */
function mount(proposal?: CanvasProposal): void {
  vi.mocked(canvasSpace.useCanvasSpace).mockReturnValue(mockSpace([], true));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: React.ReactElement = (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        {proposal ? <ProposalCard proposal={proposal} /> : null}
        <CanvasSpace projectId={PID} spaceId={SID} readOnly={false} />
      </TooltipProvider>
    </QueryClientProvider>
  );
  render(tree);
}

/**
 * A node's id by its name.
 * @param name - The name the proposal gave it.
 * @returns Its id.
 * @throws {Error} When no node carries the name.
 */
function idNamed(name: string): string {
  const found = canvasSpace.readCanvasGraph(PID, SID).nodes.find((n) => (n.data as { name?: string }).name === name);
  if (!found) throw new Error(`no node named ${name}`);
  return found.id;
}

/**
 * Presses the card's button and waits for the canvas to take the intent.
 * @returns Nothing.
 */
async function pressUse(): Promise<void> {
  await waitFor(() => expect(useCanvasStore.getState().canvasListening).toBe(true));
  fireEvent.click(screen.getByTestId('proposal-use'));
  await waitFor(() => expect(useCanvasStore.getState().pendingNodeCreate).toBeNull());
}

beforeEach(() => {
  sizeGateProviders.length = 0;
  panels.placeTemplate = null;
  useCurrentUserStore.getState().setUser({ id: 'u-9', name: 'Ada', email: 'ada@example.com', personalStudio: null, membershipTier: 'base' });
  useCanvasStore.setState({ pendingNodeCreate: null, proposalOutcome: null });
  vi.spyOn(modelsApi, 'list').mockResolvedValue({ image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1 });
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  canvasSpace._resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('W-70 a template picked in a full Space is refused with a toast', () => {
  it('placeProposalAt reports full and writes nothing', () => {
    const doc = openAt(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    const { result } = renderHook(() => useNodeCreation(PID, SID));
    const placed: unknown = result.current.placeProposalAt(proposalOf(), { x: 0, y: 0 }, [], new Map(), [0, 1, 2]);
    expect(placed).toEqual({ ok: false, reason: 'full' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('placeTemplate warns once, does not frame anything and does not throw', () => {
    const doc = openAt(F_FULL);
    mount();
    expect(panels.placeTemplate).toBeTypeOf('function');
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    expect(() => panels.placeTemplate!(proposalOf(), new Map(), [0, 1, 2])).not.toThrow();
    // `showPlaced` schedules its framing frame synchronously; none means it was not called.
    expect(frame).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap(CANVAS_NODES_KEY).size).toBe(0);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-71 a template larger than the room left is refused', () => {
  it('placeProposalAt reports no_room with the room left and writes nothing', () => {
    const doc = openAt(F_WARNING_TIGHT);
    const before = Y.encodeStateAsUpdate(doc);
    const { result } = renderHook(() => useNodeCreation(PID, SID));
    const placed: unknown = result.current.placeProposalAt(proposalOf(), { x: 0, y: 0 }, [], new Map(), [0, 1, 2]);
    expect(placed).toEqual({ ok: false, reason: 'no_room', room: 1 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('placeTemplate names the room left and does not frame anything', () => {
    const doc = openAt(F_WARNING_TIGHT);
    mount();
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    panels.placeTemplate!(proposalOf(), new Map(), [0, 1, 2]);
    expect(frame).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_NO_ROOM('1 B'));
  });
});

describe('W-72 an Agent proposal in a full Space', () => {
  it('is reported through the card as one warning and leaves the card ready', async () => {
    const doc = openAt(F_FULL);
    const proposal = proposalOf();
    mount(proposal);
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    await pressUse();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_PROPOSAL_FULL);
    expect(toast.error).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(screen.getByTestId('proposal-card')).not.toHaveTextContent(COPY_EN.T_PROPOSAL_FULL);
    expect(screen.getByTestId<HTMLButtonElement>('proposal-use').disabled).toBe(false);
    expect(useCanvasStore.getState().proposalOutcome).toBeNull();
  });
});

describe('W-73 an Agent proposal larger than the room left', () => {
  it('names the room left through the card', async () => {
    const doc = openAt(F_WARNING_TIGHT);
    mount(proposalOf());
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    await pressUse();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_PROPOSAL_NO_ROOM('1 B'));
    expect(toast.error).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('counts room another operation holds as taken', async () => {
    const doc = openAt(F_WARNING);
    const held = reserveSpaceRoom(NAME, 500000, { notify: false });
    expect(held.ok).toBe(true);
    // Its prompt alone is more than the 286432 bytes left beside the reservation.
    mount(proposalOf('x'.repeat(300000)));
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    await pressUse();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_PROPOSAL_NO_ROOM('279.7 KiB'));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('W-74 prompts, lyrics and shots land with the batch', () => {
  it('writes every fragment without a separate check', async () => {
    openAt(F_WARNING);
    mount();
    vi.mocked(toast.warning).mockClear();
    act(() => useCanvasStore.getState().requestNodeCreate({ proposal: proposalOf() }));
    await waitFor(() => expect(useCanvasStore.getState().pendingNodeCreate).toBeNull());
    expect(useCanvasStore.getState().proposalOutcome).toBe('placed');
    const verse = idNamed('Verse');
    const song = idNamed('Song');
    const clip = idNamed('Clip');
    expect(bodyToPlainText(canvasSpace.getPromptFragment(PID, SID, song, 't2m')!)).toBe('gentle pop');
    expect(canvasSpace.getLyricsFragment(PID, SID, song, 't2m')!.toJSON()).toContain(`sourceNodeId="${verse}"`);
    const shots = readShots(PID, SID, clip);
    expect(shots?.map((shot) => shot.duration)).toEqual([2, 3]);
    expect(bodyToPlainText(shots![0]!.prompt)).toBe('first shot');
    expect(bodyToPlainText(shots![1]!.prompt)).toBe('second shot');
    expect(canvasSpace.readTextBodies(PID, SID, [verse]).get(verse)).toBe('la la');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-75 a write that throws part way still rolls back', () => {
  it('reports failed, leaves nothing and no undo step, and says nothing about size', async () => {
    const doc = openAt(F_NORMAL);
    mount();
    vi.mocked(toast.warning).mockClear();
    const undo = canvasSpace.getCanvasUndoManager(doc, NAME);
    const stack = undo.undoStack.length;
    const original = canvasSpace.setNodeMode;
    let calls = 0;
    vi.spyOn(canvasSpace, 'setNodeMode').mockImplementation((...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2) throw new Error('write failed');
      original(...args);
    });
    act(() => useCanvasStore.getState().requestNodeCreate({ proposal: proposalOf() }));
    await waitFor(() => expect(useCanvasStore.getState().pendingNodeCreate).toBeNull());
    expect(calls).toBe(2);
    expect(useCanvasStore.getState().proposalOutcome).toBe('failed');
    // A rollback is an undo, which leaves tombstones, so the encoded state
    // cannot be byte-equal; what was there is compared instead.
    expect(doc.getMap(CANVAS_NODES_KEY).size).toBe(0);
    expect(canvasSpace.readCanvasGraph(PID, SID)).toEqual({ nodes: [], edges: [] });
    expect(undo.undoStack.length).toBe(stack);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('a rollback that brings back more than the room left', () => {
  it('still takes the whole placement back', () => {
    const { doc, provider } = openSizedDoc(NAME);
    canvasSpace.addNode(PID, SID, {
      id: 'g', type: 'video', position: { x: 0, y: 0 },
      data: { name: 'Clip', createdAt: 1, createdBy: 'u1', locked: false, state: 'idle', attachments: [], mode: 'multi_shot', model: 'some-model' },
    } as never);
    const prompt = canvasSpace.getPromptFragment(PID, SID, 'g', 'multi_shot')!;
    doc.transact(() => writeProposalPrompt(prompt, [{ text: 'x'.repeat(3000) }]));
    pushSize(provider, { ...F_WARNING, room: 1500 });
    vi.spyOn(storyboard, 'setStoryboardShots').mockImplementation(() => {
      throw new Error('write failed');
    });
    const reuse: CanvasProposal = {
      nodes: [{
        role: 'generate', type: 'video', name: 'Clip', mode: 'multi_shot', model: 'some-model', takesPrompt: true, params: {},
        prompt: [{ text: 'short' }], shots: [{ prompt: [{ text: 's' }], duration: 2 }],
      }],
      edges: [],
      rationale: 'r',
    };
    const { result } = renderHook(() => useNodeCreation(PID, SID));
    expect(() => result.current.placeProposalAt(reuse, { x: 0, y: 0 }, [], new Map<number, ExistingNode>([[0, { nodeId: 'g', mention: { sourceNodeId: 'g', label: 'Clip', kind: 'video' } }]]), [0])).toThrow('write failed');
    expect(bodyToPlainText(canvasSpace.getPromptFragment(PID, SID, 'g', 'multi_shot')!)).toBe('x'.repeat(3000));
  });
});
