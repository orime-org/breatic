// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which picture the camera-angle sphere's card carries, chosen where the
 * panel knows the board: the first image the prompt @-mentions, in rail order.
 */

import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import type { CameraAngleSphereProps } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

vi.mock('@web/spaces/canvas/generate/CameraAngleSphere', () => ({
  default: (props: CameraAngleSphereProps) => <div data-testid='fake-sphere' data-subject={props.subjectUrl ?? ''} />,
}));
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: false, status: 'connecting', authFailedReason: null })),
}));

import { modelsApi } from '@web/data/api';
import { addEdge, addNode, getPromptFragment, nodeDataMap } from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { corsUrl } from '@web/lib/cors-url';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';

import { CAMERA_SPECS } from './camera-angle-specs';

const QWEN: ModelEntry = {
  name: 'qwen-image-edit-multiple-angles',
  display_name: 'Qwen Image Multiple Angles',
  modality: 'image',
  mode: 'i2i',
  description: '',
  guide: '',
  tier: 'optional',
  generation_time: 120,
  takes_prompt: true,
  params: {
    images: { description: '', default: null, type: 'list', fill: 'pool', accepts: 'image' },
    ...CAMERA_SPECS,
  },
  providers: [],
  camera_angle: { azimuth: 'horizontal_angle', elevation: 'vertical_angle', distance: 'distance' },
};

const CATALOG: ModelCatalog = { image: [QWEN], video: [], audio: [], tts: [], three_d: [], total: 1, credit_multiplier: 1 };

const SOURCES = [
  { id: 'ref-a', data: { kind: 'image' as const, handling: false as const, name: 'A', content: 'https://cdn.test/a.png' } },
  { id: 'ref-b', data: { kind: 'image' as const, handling: false as const, name: 'B', content: 'https://cdn.test/b.png' } },
];
const WIRES = [
  { id: 'r-a', source: 'ref-a', target: 'target' },
  { id: 'r-b', source: 'ref-b', target: 'target' },
];

/**
 * Seeds the target and both sources in the doc, wires them, and writes a
 * prompt that @-mentions the given sources.
 * @param mentioned - The source ids the prompt mentions, in order.
 */
function seedBoard(mentioned: string[]): void {
  addNode('p', 's', {
    id: 'target',
    type: 'image',
    position: { x: 0, y: 0 },
    data: { name: 'T', createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], mode: 'i2i', model: QWEN.name },
  } as Parameters<typeof addNode>[2]);
  for (const source of SOURCES) {
    addNode('p', 's', {
      id: source.id,
      type: 'image',
      position: { x: 0, y: 0 },
      data: { name: source.data.name, createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], content: source.data.content },
    } as Parameters<typeof addNode>[2]);
  }
  for (const wire of WIRES) addEdge('p', 's', wire);
  const mode = nodeDataMap(getDoc(docName.canvasSpace('p', 's')), 'target')?.get('mode');
  const fragment = getPromptFragment('p', 's', 'target', typeof mode === 'string' ? mode : 'i2i');
  if (!fragment) throw new Error('the target has no prompt fragment');
  const paragraph = new Y.XmlElement('paragraph');
  fragment.insert(0, [paragraph]);
  const words = new Y.XmlText();
  paragraph.insert(0, [words]);
  words.insert(0, 'turn the camera');
  for (const id of mentioned) {
    const chip = new Y.XmlElement('referenceMention');
    paragraph.insert(paragraph.length, [chip]);
    chip.setAttribute('sourceNodeId', id);
    chip.setAttribute('kind', 'image');
  }
}

/**
 * Opens the panel and its settings popover, and returns the sphere stub.
 * @param mentioned - The source ids the prompt mentions.
 * @returns The sphere stub.
 */
async function openSphere(mentioned: string[]): Promise<HTMLElement> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(CATALOG);
  seedBoard(mentioned);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReactFlow nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
        <CanvasContext.Provider value={{ projectId: 'p', spaceId: 's', readOnly: false, myRole: 'editor', caretProvider: null }}>
          <GeneratePanelContainer
            projectId='p'
            spaceId='s'
            nodes={[{ id: 'target', data: { kind: 'image', handling: false } }, ...SOURCES]}
            edges={WIRES}
            getLastWriteWasLocal={() => true}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>,
  );
  act(() => {
    canvasSessions.of('s').getState().openGeneratePanel('target', 'image');
  });
  const trigger = await screen.findByTestId('generate-ratio-trigger');
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
  return screen.findByTestId('fake-sphere');
}

describe('the camera-angle sphere\'s card', () => {
  beforeEach(() => {
    _resetForTests();
    canvasSessions.of('s').setState({ panelHostId: null, panelKind: null, pickSession: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the image the prompt @-mentions, not the first one connected', async () => {
    const sphere = await openSphere(['ref-b']);
    await waitFor(() => expect(sphere.getAttribute('data-subject')).toBe(corsUrl('https://cdn.test/b.png')));
  });

  it('takes the first mentioned image in rail order when the prompt names two', async () => {
    const sphere = await openSphere(['ref-b', 'ref-a']);
    await waitFor(() => expect(sphere.getAttribute('data-subject')).toBe(corsUrl('https://cdn.test/a.png')));
  });

  it('is plain while the prompt mentions no image', async () => {
    const sphere = await openSphere([]);
    // Both images are on the rail, so the card has a picture to take if it ignored the prompt.
    await screen.findByTestId('generate-ref-insert-r-b');
    expect(sphere.getAttribute('data-subject')).toBe('');
  });
});
