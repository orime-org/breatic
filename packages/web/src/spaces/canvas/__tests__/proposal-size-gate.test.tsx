// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web spec RQ-03, RQ-04): templates and Agent
 * canvas proposals are refused before anything is fetched, and write the
 * whole flow as one `add` batch. A picked template says a refusal in the add
 * toast; an Agent proposal is told once, through the card's outcome toast,
 * and its result's reason follows the state (Q4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';
import { CANVAS_NODES_KEY, type CanvasProposal } from '@breatic/shared';

import type { ExistingNode } from '@web/spaces/canvas/use-node-creation';

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
import { canvasApi } from '@web/data/api/canvas';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { readShots } from '@web/data/yjs/node-storyboard';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { ProposalCard } from '@web/pages/project/chat/ProposalCard';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { mockSpace } from '@web/spaces/canvas/__tests__/focus-harness';
import { useCanvasStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';
import {
  SIZE_COPY_EN,
  enterSize,
  expectSizeToast,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p-prop';
const SID = 's-prop';
const NAME = docName.canvasSpace(PID, SID);

/**
 * The proposal every case lands: a written text node whose words go into a
 * song's lyrics box, the song with its own prompt, a multi-shot clip with two
 * shots, and a template source picture whose hosted resource is fetched into
 * storage after the write.
 * @returns The proposal.
 */
function proposalOf(): CanvasProposal {
  return {
    nodes: [
      { role: 'written', type: 'text', name: 'Verse', prompt: [{ text: 'la la' }] },
      { role: 'generate', type: 'audio', name: 'Song', mode: 't2m', model: 'some-model', takesPrompt: true, params: {}, prompt: [{ text: 'gentle pop' }] },
      {
        role: 'generate', type: 'video', name: 'Clip', mode: 'multi_shot', model: 'some-model', takesPrompt: true, params: {},
        shots: [
          { prompt: [{ text: 'first shot' }], duration: 2 },
          { prompt: [{ text: 'second shot' }], duration: 3 },
        ],
      },
      { role: 'source', type: 'image', name: 'Ref', resource: 'templates/ref.png' },
    ],
    edges: [{ fromIndex: 0, toIndex: 1, into: 'lyrics' }],
    rationale: 'A song and a clip',
    groupName: 'G',
  };
}

/**
 * Opens the Space in one size state.
 * @param code - The size state.
 * @returns The canvas document.
 */
function openAt(code: SizeCode): Y.Doc {
  const doc = getDoc(NAME);
  enterSize(NAME, code);
  return doc;
}

/**
 * Mounts the canvas, optionally beside the card that posts `proposal`.
 * @param proposal - A proposal whose card is mounted too.
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
 */
async function pressUse(): Promise<void> {
  await waitFor(() => expect(useCanvasStore.getState().canvasListening).toBe(true));
  fireEvent.click(screen.getByTestId('proposal-use'));
  await waitFor(() => expect(useCanvasStore.getState().pendingNodeCreate).toBeNull());
}

beforeEach(() => {
  panels.placeTemplate = null;
  useCurrentUserStore.getState().setUser({ id: 'u-9', name: 'Ada', email: 'ada@example.com', personalStudio: null, membershipTier: 'base' });
  useCanvasStore.setState({ pendingNodeCreate: null, proposalOutcome: null });
  vi.spyOn(modelsApi, 'list').mockResolvedValue({ image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1 });
  vi.spyOn(canvasApi, 'ingestUrl').mockResolvedValue(undefined as never);
});

afterEach(() => {
  clearAllDocSizes();
  _resetForTests();
  canvasSpace._resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('RQ-03 a template picked in a Space that cannot take an add', () => {
  it.each([
    ['F', SIZE_COPY_EN.T_ADD],
    ['O', SIZE_COPY_EN.T_OVER],
    ['Z', null],
  ] as const)('RQ-03 [%s] placeTemplate writes nothing, fetches no resource, frames nothing and does not throw', (code, sentence) => {
    const doc = openAt(code);
    mount();
    expect(panels.placeTemplate).toBeTypeOf('function');
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    expect(() => panels.placeTemplate!(proposalOf(), new Map(), [0, 1, 2, 3])).not.toThrow();
    // `showPlaced` schedules its framing frame synchronously; none means it was not called.
    expect(frame).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap(CANVAS_NODES_KEY).size).toBe(0);
    expect(canvasApi.ingestUrl).not.toHaveBeenCalled();
    expectSizeToast(sentence);
  });

  it('RQ-03 [W] a template with room lands and fetches its resource once (control)', () => {
    const doc = openAt('W');
    mount();
    vi.mocked(toast.warning).mockClear();
    panels.placeTemplate!(proposalOf(), new Map(), [0, 1, 2, 3]);
    expect(doc.getMap(CANVAS_NODES_KEY).size).toBeGreaterThan(0);
    expect(canvasApi.ingestUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(canvasApi.ingestUrl).mock.calls[0][0]).toMatchObject({ template_resource: 'templates/ref.png', node_id: idNamed('Ref') });
    expectSizeToast(null);
  });
});

describe('RQ-04 an Agent canvas proposal in a Space that cannot take an add', () => {
  it.each([
    ['F', 'full'],
    ['O', 'over_ceiling'],
    ['Z', 'resyncing'],
  ] as const)('RQ-04 [%s] placeProposalAt without notify returns the refusal, writes nothing and shows no toast', (code, reason) => {
    const doc = openAt(code);
    const before = Y.encodeStateAsUpdate(doc);
    const { result } = renderHook(() => useNodeCreation(PID, SID));
    vi.mocked(toast.warning).mockClear();
    const placed: unknown = result.current.placeProposalAt(proposalOf(), { x: 0, y: 0 }, [], new Map(), [0, 1, 2, 3], false);
    expect(placed).toEqual({ ok: false, reason });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(canvasApi.ingestUrl).not.toHaveBeenCalled();
    expectSizeToast(null);
  });

  it.each([
    ['F', SIZE_COPY_EN.T_PROPOSAL],
    ['O', SIZE_COPY_EN.T_PROPOSAL],
  ] as const)('RQ-04 [%s] the card says the proposal was not placed, once, and stays ready', async (code, sentence) => {
    const doc = openAt(code);
    const proposal = proposalOf();
    mount(proposal);
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    await pressUse();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expectSizeToast(sentence);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(canvasApi.ingestUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId<HTMLButtonElement>('proposal-use').disabled).toBe(false);
    expect(useCanvasStore.getState().proposalOutcome).toBeNull();
  });
});

describe('RQ-04 prompts, lyrics and shots land with the batch when there is room', () => {
  it('RQ-04 [W] writes every fragment without a separate check', async () => {
    openAt('W');
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
    expectSizeToast(null);
  });
});

describe('a write that throws part way still rolls back', () => {
  it('reports failed, leaves nothing and no undo step, and says nothing about size', async () => {
    const doc = openAt('U');
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
