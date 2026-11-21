// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §69 U05 (frames-split design §7.8 surface list row for `HoverPreview.tsx` and its callers, the node
 * history and the project activity panel; §7.9 last paragraph): a video hover preview reads the same presentation query
 * Qp as the canvas node. With a selected version P it plays P's playback file; with nothing selected and an original the
 * browser cannot play, it shows the cover and "Preparing video…"; a failed candidate shows only the reason, no Retry.
 * The preview learns its Project from a `projectId` prop, which both callers pass.
 */

import * as React from 'react';
import { Film } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPresentationResponse } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { HoverPreview, type HoverPreviewProps } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { presentedBinding, presentedBundle, presentedPreparation, presentedResponse } from '@web/test-utils/video-presentation';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import { NodeHistoryRow } from '@web/spaces/canvas/history/NodeHistoryRow';
import { ProjectActivityButton } from '@web/pages/project/chrome/tab-bar/ProjectActivityButton';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import type { MiniToolSlotValue } from '@breatic/shared/mini-tools';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { MediaFullscreen } from '@web/spaces/canvas/nodes/_shared/MediaFullscreen';
import { JoinClipRow } from '@web/spaces/canvas/mini-tool/JoinClipRow';
import { joinToolFor } from '@web/spaces/canvas/mini-tool/join';
import { SlotTool } from '@web/spaces/canvas/generate/generate-tools';
import { ReferenceRail } from '@web/spaces/canvas/generate/ReferenceRail';
import { ReferenceMention, referenceMentionContent } from '@web/spaces/canvas/generate/reference-mention';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { AttachmentHover } from '@web/pages/project/chat/AttachmentChip';
import { QuestionnaireCard } from '@web/pages/project/chat/QuestionnaireCard';
import { QuestionnaireAnswerContext } from '@web/pages/project/chat/questionnaire-answer';
import type * as RequestModule from '@web/data/api/request';
import type * as RendererModule from '@web/spaces/canvas/video-presentation/create-video-renderer';
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(() => new Promise<never>(() => undefined)),
}));
const { listActivities } = vi.hoisted(() => ({ listActivities: vi.fn() }));
vi.mock('@web/data/api/activities', () => ({ activitiesApi: { list: listActivities } }));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  createVideoRenderer: vi.fn((host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    const element = document.createElement('video');
    element.setAttribute('src', source.presentation.playback.carrier.url);
    host.append(element);
    queueMicrotask(() => callbacks.ready(element, element));
    return { dispose: () => element.remove() };
  }),
}));

const Preview = HoverPreview as unknown as React.ComponentType<HoverPreviewProps & { projectId: string }>;
const PROJECT = '60000000-0000-4000-8000-000000000012';
const ORIGINAL = 'https://assets.example.test/hover/source.mov';
const PLAYBACK = 'https://assets.example.test/hover/playback.mp4';
const COVER = 'https://assets.example.test/hover/cover.jpg';
let client: QueryClient;

/**
 * Renders a video hover preview over a seeded presentation read and opens it.
 * @param response - The read Qp answers for the original URL.
 * @returns The opened card's content.
 */
function open(response: VideoPresentationResponse): HTMLElement {
  client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, response);
  render(<QueryClientProvider client={client}><TooltipProvider><Preview kind='video' src={ORIGINAL} poster={COVER} projectId={PROJECT}><span data-testid='trigger'>row</span></Preview></TooltipProvider></QueryClientProvider>);
  fireEvent.pointerEnter(screen.getByTestId('trigger'), { pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10); });
  return screen.getByTestId('hover-preview-content');
}

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('U05 a video hover preview plays through Qp (§7.8, §7.9)', () => {
  it('U05: with a selected version the preview plays the playback file, not the original', async () => {
    const bundle = presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'hover/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    const card = open(presentedResponse(presentedBinding(ORIGINAL), { presentation: bundle }));
    await act(async () => { await Promise.resolve(); });
    expect(card.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(card.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  });

  it('U05: preparing, an original the browser cannot play shows the cover and "Preparing video…"', () => {
    const card = open(presentedResponse(presentedBinding(ORIGINAL), { preparation: presentedPreparation(null) }));
    const original = card.querySelector(`video[src="${ORIGINAL}"]`);
    expect(original).not.toBeNull();
    fireEvent.error(original!);
    expect(screen.getByText('Preparing video…')).toBeInTheDocument();
    expect(card.querySelector(`[src="${COVER}"], [poster="${COVER}"]`)).not.toBeNull();
  });

  it('U05: a failed candidate shows only the reason, with no Retry in a hover preview', () => {
    const card = open(presentedResponse(presentedBinding(ORIGINAL), { preparation: presentedPreparation('expired') }));
    const original = card.querySelector(`video[src="${ORIGINAL}"]`);
    if (original !== null) fireEvent.error(original);
    expect(screen.getByText('Couldn\'t prepare the video')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('U05 callers: the node history and the project activity panel pass their Project (§7.8 surface list)', () => {
  /**
   * Seeds Qp with a selected version whose playback file differs from the original.
   * @throws {never} Never.
   */
  function seedSelected(): void {
    const bundle = presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'hover/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, presentedResponse(presentedBinding(ORIGINAL), { presentation: bundle }));
  }

  /**
   * Hovers a trigger past the open delay and lets the renderer report ready.
   * @param trigger - The preview trigger.
   * @returns The opened card's content.
   */
  async function hover(trigger: HTMLElement): Promise<HTMLElement> {
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10); });
    await act(async () => { await Promise.resolve(); });
    return screen.getByTestId('hover-preview-content');
  }

  it('U05: a video row of the node history plays the selected playback file', async () => {
    seedSelected();
    const entry: NodeHistoryEntry = { id: 'h1', operatorName: null, entryType: 'generation', status: 'success', content: ORIGINAL, thumbnailUrl: COVER, errorMessage: null, metadata: {},
      mediaWidth: 320, mediaHeight: 180, duration: 2, mimeType: 'video/quicktime', size: 1024, createdAt: '2026-11-21T00:00:00.000Z' };
    render(<QueryClientProvider client={client}><TooltipProvider><NodeHistoryRow entry={entry} modality='video' projectId={PROJECT} isCurrent={false} isFocused={false} onRestore={() => undefined} /></TooltipProvider></QueryClientProvider>);
    const card = await hover(screen.getByTestId('node-history-row').firstElementChild as HTMLElement);
    expect(card.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(card.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  });

  it('U05: an uploaded video in the project activity panel plays the selected playback file', async () => {
    seedSelected();
    listActivities.mockResolvedValue({ items: [{ id: 'a-1', projectId: PROJECT, actorUserId: 'u-1', actorName: 'Yuki', type: 'asset:uploaded', spaceId: null, nodeId: null, taskId: null,
      payload: { kind: 'video', fileUrl: ORIGINAL, thumbnailUrl: COVER }, restored: false, createdAt: Date.now() - 60_000 }], nextCursor: null });
    render(<QueryClientProvider client={client}><TooltipProvider><ProjectActivityButton projectId={PROJECT} /></TooltipProvider></QueryClientProvider>);
    fireEvent.click(screen.getByTestId('project-activity-trigger'));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const card = await hover(screen.getByTestId('project-activity-thumb-a-1'));
    expect(card.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(card.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  });
});

describe('U05 full screen and every other video hover preview play through Qp (§7.8 surface list and fullscreen invariant)', () => {
  const CANVAS: CanvasContextValue = { projectId: PROJECT, spaceId: 'space-1', readOnly: false, myRole: 'owner', caretProvider: null };

  /**
   * Seeds Qp with a selected version whose playback file differs from the original.
   * @throws {never} Never.
   */
  function seedSelected(): void {
    const bundle = presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'hover/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, presentedResponse(presentedBinding(ORIGINAL), { presentation: bundle }));
  }

  /**
   * Renders under the query client, the tooltip provider and the canvas of the Project.
   * @param node - What to render.
   * @returns Nothing.
   */
  function mount(node: React.ReactNode): void {
    render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={CANVAS}>{node}</CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  }

  /**
   * Renders a chat surface under the Project's route.
   * @param node - What to render.
   * @returns Nothing.
   */
  function mountInChat(node: React.ReactNode): void {
    render(<QueryClientProvider client={client}><TooltipProvider><MemoryRouter initialEntries={[`/project/clip-${PROJECT}`]}><Routes><Route path='/project/:projectId' element={node} /></Routes></MemoryRouter></TooltipProvider></QueryClientProvider>);
  }

  /**
   * Hovers a trigger past the open delay and lets the renderer report ready.
   * @param trigger - The preview trigger.
   * @returns The opened card's content.
   */
  async function hover(trigger: HTMLElement): Promise<HTMLElement> {
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10); });
    await act(async () => { await Promise.resolve(); });
    return screen.getByTestId('hover-preview-content');
  }

  /**
   * Asserts an element plays the playback file and not the original.
   * @param root - Where the player is.
   * @throws {Error} When it plays the original.
   */
  function expectPlayback(root: ParentNode): void {
    expect(root.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(root.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  }

  it('U05: full screen on a registered video of the Project plays the selected playback file', async () => {
    seedSelected();
    render(<QueryClientProvider client={client}><MediaFullscreen kind='video' src={ORIGINAL} poster={COVER} projectId={PROJECT} name='clip' onClose={() => undefined} /></QueryClientProvider>);
    await act(async () => { await Promise.resolve(); });
    expectPlayback(screen.getByTestId('media-fullscreen'));
  });

  it('U05: the hover preview opens full screen on the selected playback file', async () => {
    const card = open(presentedResponse(presentedBinding(ORIGINAL), { presentation: presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'hover/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } }) }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(card.querySelector('[data-testid="media-fullscreen-button"]')!);
    await act(async () => { await Promise.resolve(); });
    expectPlayback(screen.getByTestId('media-fullscreen'));
  });

  it('U05: a join clip plays the selected playback file', async () => {
    seedSelected();
    const slot = joinToolFor('video')?.slots.find((value) => value.many);
    if (slot === undefined) throw new Error('no video join slot');
    const clip = { url: ORIGINAL, cover: COVER, duration: 2, nodeId: 'c1', name: 'C1' } as MiniToolSlotValue;
    mount(<JoinClipRow slot={slot} clips={[clip]} cap={5} picking={false} onPick={() => undefined} onMove={() => undefined} onRemove={() => undefined} />);
    const tile = screen.getByTestId('join-tile-c1');
    expectPlayback(await hover(tile.querySelector('.cursor-grab') as HTMLElement));
  });

  it('U05: a generate slot holding a video plays the selected playback file', async () => {
    seedSelected();
    mount(<SlotTool testId='slot' thumbnailTestId='slot-thumb' clearTestId='slot-clear' Icon={Film} onPick={() => undefined} active={false}
      pick={{ kind: 'video', url: ORIGINAL, thumbnail: COVER } as React.ComponentProps<typeof SlotTool>['pick']} onClear={() => undefined} disabled={false} clearLabel='Clear' label='Video' tip='Pick a video' />);
    expectPlayback(await hover(screen.getByTestId('slot')));
  });

  it('U05: a video row of the reference rail plays the selected playback file', async () => {
    seedSelected();
    const row: ReferenceRailItem = { refId: 'e-video', sourceNodeId: 'n-video', sourceNodeType: 'video', sourceNodeName: 'Clip', thumbnail: COVER, mediaUrl: ORIGINAL };
    mount(<ReferenceRail references={[row]} onRemove={() => undefined} onInsert={() => undefined} referenceKinds={['video']} />);
    expectPlayback(await hover(screen.getByTestId('generate-ref-insert-e-video')));
  });

  it('U05: a video @ reference opens full screen on the selected playback file', async () => {
    seedSelected();
    const row: ReferenceRailItem = { refId: 'e-video', sourceNodeId: 'n-video', sourceNodeType: 'video', sourceNodeName: 'Clip', thumbnail: COVER, mediaUrl: ORIGINAL };
    /**
     * An editor holding one video chip whose pool row names the original.
     * @returns The editor.
     */
    function Host(): React.JSX.Element {
      const editor = useEditor({ extensions: [Document, Paragraph, Text, ReferenceMention.configure({ getPool: () => [row] })],
        content: { type: 'doc', content: [{ type: 'paragraph', content: [referenceMentionContent(row)] }] }, immediatelyRender: true });
      return <EditorContent editor={editor} />;
    }
    mount(<Host />);
    await act(async () => { await Promise.resolve(); });
    const card = await hover(document.querySelector('.reference-mention') as HTMLElement);
    fireEvent.click(card.querySelector('[data-testid="media-fullscreen-button"]')!);
    await act(async () => { await Promise.resolve(); });
    expectPlayback(screen.getByTestId('media-fullscreen'));
  });

  it('U05: a video attached to the chat plays the selected playback file', async () => {
    seedSelected();
    const chip = { id: 'chip-1', type: 'video', name: 'Clip', data_snapshot: { url: ORIGINAL } } as unknown as React.ComponentProps<typeof AttachmentHover>['chip'];
    mountInChat(<AttachmentHover chip={chip} name='Clip'><span data-testid='chip-trigger'>Clip</span></AttachmentHover>);
    expectPlayback(await hover(screen.getByTestId('chip-trigger')));
  });

  it('U05: a video option of a questionnaire plays the selected playback file', async () => {
    seedSelected();
    const questions = [{ header: 'Style', question: 'Which style?', multiSelect: false, options: [{ label: 'Sea', media: { kind: 'video' as const, url: ORIGINAL, poster: COVER } }, { label: 'Film' }] }];
    mountInChat(<QuestionnaireAnswerContext.Provider value={{ answer: async () => undefined, busy: false }}><QuestionnaireCard questionnaire={{ toolCallId: 'ask-1', questions, state: 'awaiting' }} /></QuestionnaireAnswerContext.Provider>);
    const tile = screen.getAllByTestId('questionnaire-tile')[0]!;
    expectPlayback(await hover(tile.querySelector('img')!.parentElement as HTMLElement));
  });
});
