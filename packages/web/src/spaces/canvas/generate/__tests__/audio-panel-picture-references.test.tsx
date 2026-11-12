// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A video and a picture wired into an audio node (inner#1825 §5): once the
 * canvas lets those edges be drawn, the audio panel's reference rail lists
 * them under the usability rules every panel follows. No audio model takes a
 * video or a picture into its reference pool (they reach a model through the
 * slots), so both rows are dimmed and refuse to be inserted, and the `@` list
 * offers neither, while a wired text node stays offered.
 *
 * Characterisation: the audio panel already passes no reference kinds, and
 * this pins that the new edges change nothing about it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { Editor } from '@tiptap/core';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type { ReactNode } from 'react';
import * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: false, status: 'connecting' as const, authFailedReason: null })),
}));

import { modelsApi } from '@web/data/api';
import { addEdge, addNode, ensureTextBody, getPromptFragment } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import type { AudioNodeView } from '@web/data/yjs/node-view';
import { toast } from '@web/lib/toast';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { AudioGeneratePanelContainer } from '@web/spaces/canvas/generate/AudioGeneratePanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';

/** A sound-effects model that reads a clip through its slot. */
const SFX = {
  name: 'sfx-model',
  display_name: 'SFX',
  modality: 'audio',
  mode: 'sfx',
  description: '',
  guide: '',
  tier: 'recommended',
  generation_time: 30,
  takes_prompt: true,
  params: { video: { description: '', default: null, fill: 'canvas', accepts: 'video', optional: true } },
  providers: [],
} as unknown as ModelEntry;

const CATALOG = { image: [], video: [], audio: [SFX], tts: [], three_d: [], total: 1, credit_multiplier: 1 } as unknown as ModelCatalog;

type BoardNodes = Parameters<typeof AudioGeneratePanelContainer>[0]['nodes'];

/**
 * Puts a node on the document and wires it into the audio node.
 * @param id - Its id.
 * @param type - Its type.
 * @param data - Its data.
 */
function seedWired(id: string, type: 'video' | 'image' | 'text', data: Record<string, unknown>): void {
  addNode('p', 's', {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { createdAt: 1000, createdBy: 'u1', locked: false, state: 'idle', attachments: [], ...data },
  } as unknown as Parameters<typeof addNode>[2]);
  addEdge('p', 's', { id: `e-${id}`, source: id, target: 'target' });
}

/** Mounts the audio panel on `target`, with a video, a picture and a text node wired into it. */
async function openPanel(): Promise<void> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(CATALOG);
  addNode('p', 's', {
    id: 'target',
    type: 'audio',
    position: { x: 0, y: 0 },
    data: { name: 'Sound', createdAt: 1000, createdBy: 'u1', locked: false, state: 'idle', attachments: [], mode: 'sfx', model: 'sfx-model' },
  } as Parameters<typeof addNode>[2]);
  seedWired('vid', 'video', { name: 'Clip', content: 'https://cdn/clip.mp4', coverUrl: 'https://cdn/clip.jpg' });
  seedWired('img', 'image', { name: 'Mood', content: 'https://cdn/mood.png' });
  seedWired('txt', 'text', { name: 'Lines' });
  const body = ensureTextBody('p', 's', 'txt');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('rain on a tin roof')]);
  body?.insert(0, [paragraph]);

  const board: BoardNodes = [
    { id: 'target', type: 'audio', data: { handling: false, mode: 'sfx', model: 'sfx-model' } as AudioNodeView },
    { id: 'vid', type: 'video', data: { handling: false, name: 'Clip', content: 'https://cdn/clip.mp4', coverUrl: 'https://cdn/clip.jpg' } },
    { id: 'img', type: 'image', data: { handling: false, name: 'Mood', content: 'https://cdn/mood.png' } },
    { id: 'txt', type: 'text', data: { handling: false, name: 'Lines' } },
  ] as BoardNodes;
  const canvas: CanvasContextValue = { projectId: 'p', spaceId: 's', readOnly: false, myRole: 'editor', caretProvider: null };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReactFlow nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]} edges={[]} panOnDrag={false}>
        <CanvasContext.Provider value={canvas}>
          <AudioGeneratePanelContainer
            projectId='p'
            spaceId='s'
            getLastWriteWasLocal={() => true}
            placeTemplate={() => ({ nodeIds: [], rects: [] })}
            edges={['vid', 'img', 'txt'].map((id) => ({ id: `e-${id}`, source: id, target: 'target' }))}
            nodes={board}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>,
  );
  act(() => {
    canvasSessions.of('s').getState().openGeneratePanel('target', 'audio');
  });
  await screen.findByTestId('generate-audio-execute');
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  canvasSessions.of('s').setState({ panelHostId: null, panelKind: null, pickSession: null });
});

describe('a video and a picture wired into an audio node (inner#1825 §5)', () => {
  it('lists both on the rail dimmed, and refuses to insert either into the prompt', async () => {
    await openPanel();
    for (const id of ['e-vid', 'e-img']) {
      const insert = screen.getByTestId(`generate-ref-insert-${id}`);
      expect(insert, id).toHaveClass('opacity-50');
      fireEvent.click(insert);
    }
    expect(toast.warning).toHaveBeenCalledTimes(2);
    const prompt = getPromptFragment('p', 's', 'target', 'sfx')?.toString() ?? '';
    expect(prompt).not.toContain('sourceNodeId="vid"');
    expect(prompt).not.toContain('sourceNodeId="img"');
    expect(screen.getByTestId('generate-ref-insert-e-txt')).not.toHaveClass('opacity-50');
  });

  it('offers neither in the @ list, while the wired text node is offered', async () => {
    await openPanel();
    const dom = screen.getByTestId('generate-prompt-editor').querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
    const editor = dom?.editor;
    if (!editor) throw new Error('the prompt editor is not mounted');
    act(() => {
      editor.commands.focus('end');
      editor.commands.insertContent('@');
    });
    await waitFor(() => expect(document.querySelector('[data-testid^="reference-mention-option-"]')).not.toBeNull());
    const offered = [...document.querySelectorAll('[data-testid^="reference-mention-option-"]')].map((el) => el.getAttribute('data-testid') ?? '');
    expect(offered.some((id) => id.includes('txt'))).toBe(true);
    expect(offered.filter((id) => id.includes('vid') || id.includes('img'))).toEqual([]);
  });
});
