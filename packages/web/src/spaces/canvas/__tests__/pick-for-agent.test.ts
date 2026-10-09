// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What "Add to agent" hands over for an audio node with no voice picked
 * (#2218): the first voice of its model's list, read from the query the audio
 * panel uses, and fetched when it is not cached yet.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';

import { voicesApi } from '@web/data/api/voices';
import { addNode, setNodeMode } from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { firstVoiceKey } from '@web/spaces/canvas/generate/first-voice-query';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { handToAgent, pickForAgent } from '@web/spaces/canvas/pick-for-agent';
import * as attach from '@web/stores/attach-to-chat';

const PID = 'p1';
const SID = 's1';

const SPEECH = {
  name: 'speech',
  display_name: 'Speech',
  modality: 'audio',
  mode: ['tts', 'sfx'],
  description: '',
  guide: '',
  tier: 'optional',
  generation_time: 10,
  takes_prompt: true,
  params: { voice_id: { description: '', default: null, remote_source: 'voices' } },
  providers: [],
} as unknown as ModelEntry;

const CATALOG = {
  image: [], video: [], audio: [SPEECH], tts: [], three_d: [], total: 1, credit_multiplier: 1,
} as unknown as ModelCatalog;

/**
 * A client with nothing cached.
 * @returns The client.
 */
function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/**
 * The audio node's entry in what was handed over.
 * @param item - The handed-over item.
 * @returns The node's entry.
 */
function speechEntry(item: Awaited<ReturnType<typeof pickForAgent>>): Record<string, unknown> | undefined {
  return (item?.chip?.data_snapshot as { nodes: Array<Record<string, unknown>> } | undefined)?.nodes[0];
}

describe('handing an audio node to the agent', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, {
      id: 'a1',
      type: 'audio',
      position: { x: 0, y: 0 },
      data: { name: 'Voice', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
    });
    setNodeMode(PID, SID, 'a1', 'tts', 'speech', {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the cached first voice without asking again', async () => {
    const list = vi.spyOn(voicesApi, 'list');
    const queryClient = client();
    queryClient.setQueryData(firstVoiceKey('speech'), { id: 'cached', name: 'Cached' });

    const item = await pickForAgent(queryClient, CATALOG, getDoc(docName.canvasSpace(PID, SID)), ['a1']);

    expect(list).not.toHaveBeenCalled();
    expect(speechEntry(item)?.current).toMatchObject({ params: { voice_id: 'cached' } });
  });

  it('asks for the first voice when it is not cached, then names it', async () => {
    const list = vi.spyOn(voicesApi, 'list').mockResolvedValue({ voices: [{ id: 'first', name: 'First' }] } as never);

    const item = await pickForAgent(client(), CATALOG, getDoc(docName.canvasSpace(PID, SID)), ['a1']);

    expect(list).toHaveBeenCalledTimes(1);
    expect(speechEntry(item)?.current).toMatchObject({ params: { voice_id: 'first' } });
  });

  it('leaves the voice out when the list cannot be read', async () => {
    vi.spyOn(voicesApi, 'list').mockRejectedValue(new Error('down'));

    const item = await pickForAgent(client(), CATALOG, getDoc(docName.canvasSpace(PID, SID)), ['a1']);

    expect(speechEntry(item)?.current).not.toHaveProperty('params.voice_id');
  });

  it('reads the node once more after the fetch, so its data and current agree', async () => {
    vi.spyOn(voicesApi, 'list').mockImplementation(async () => {
      // A collaborator switches the mode while the list is on its way.
      setNodeMode(PID, SID, 'a1', 'sfx', 'speech', {});
      return { voices: [{ id: 'first', name: 'First' }] } as never;
    });

    const entry = speechEntry(await pickForAgent(client(), CATALOG, getDoc(docName.canvasSpace(PID, SID)), ['a1']));

    expect(entry?.data).toMatchObject({ mode: 'sfx' });
    expect(entry?.current).toMatchObject({ mode: 'sfx' });
  });
});

describe('handing a pick over', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, {
      id: 'a1',
      type: 'audio',
      position: { x: 0, y: 0 },
      data: { name: 'Voice', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the pick once the catalog is read', async () => {
    const attached = vi.spyOn(attach, 'attachToChat').mockResolvedValue();
    vi.spyOn(voicesApi, 'list').mockResolvedValue({ voices: [] } as never);
    const queryClient = client();
    queryClient.setQueryData(modelCatalogQuery().queryKey, CATALOG);

    await expect(handToAgent(queryClient, PID, getDoc(docName.canvasSpace(PID, SID)), ['a1'])).resolves.toBe(true);
    expect(attached).toHaveBeenCalledTimes(1);
  });

  it('answers that the catalog is missing, and attaches nothing, when it cannot be read', async () => {
    const attached = vi.spyOn(attach, 'attachToChat');
    const queryClient = client();
    vi.spyOn(queryClient, 'ensureQueryData').mockRejectedValue(new Error('down'));

    await expect(handToAgent(queryClient, PID, getDoc(docName.canvasSpace(PID, SID)), ['a1'])).resolves.toBe(false);
    expect(attached).not.toHaveBeenCalled();
  });
});
