// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where each request goes once the open Studio or Project lives in another
 * region (inner#1955, acceptance 2 and 7). The axios calls, the Agent chat
 * send and the streaming wrapper all go to the current region's API; calls on
 * global data (the bell, identity renewal) always go to the global region; a
 * decision link goes to the region its token names, whatever page is open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';

const fetchEventSource = vi.hoisted(() => vi.fn(async (_url: string, _init: unknown) => undefined));
// Every body goes through storage, so the routes see only a transfer reference.
vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: vi.fn(async () => ({ transfer: 'transfer/k' })),
}));
vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breatic/shared')>()),
  sendBytesToIngest: vi.fn(async () => ({ uploadId: 'up1', token: 'tok', parts: [] })),
}));
vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource }));
vi.mock('@web/data/api/regions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/regions')>()),
  getRegionConfig: vi.fn(),
}));

import { request } from '@web/data/api/request';
import { projectsApi } from '@web/data/api/projects';
import { notificationsApi } from '@web/data/api/notifications';
import { decisionsApi } from '@web/data/api/decisions';
import { getRegionConfig, parseRegionConfig, rememberProjectRegion, rememberStudioRegion, setCurrentRegion } from '@web/data/api/regions';
import { sseStream } from '@web/data/stream/sse';
import { assetsApi } from '@web/data/api/assets';
import { canvasApi } from '@web/data/api/canvas';
import { documentsApi } from '@web/data/api/documents';
import { studiosApi } from '@web/data/api/studios';
import { apiPost } from '@web/data/api/request';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatApi } from '@web/data/api/chat';

const TWO_REGIONS = parseRegionConfig(
  JSON.stringify({
    global: 'us-west',
    regions: {
      'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/collab' },
      sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/collab' },
    },
  }),
);

const US = 'https://us.example.test/api/v1';
const SG = 'https://sg.example.test/api/v1';

/** Full URLs the axios adapter saw. */
let seen: string[] = [];
let originalAdapter: typeof request.defaults.adapter;

/**
 * An adapter that records each URL and answers an empty success.
 * @param config - The request.
 * @returns An empty `{ data: {} }` answer.
 */
const record: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  seen.push(`${config.baseURL ?? ''}${config.url ?? ''}`);
  return { data: { data: {} }, status: 200, statusText: '200', headers: {}, config };
};

beforeEach(() => {
  seen = [];
  originalAdapter = request.defaults.adapter;
  request.defaults.adapter = record;
  vi.mocked(getRegionConfig).mockReturnValue(TWO_REGIONS);
  fetchEventSource.mockClear();
});

afterEach(() => {
  request.defaults.adapter = originalAdapter;
  setCurrentRegion(null);
  evictAllChatSessions();
});

describe('axios calls', () => {
  it('go to the current region for the open Project and to the global region for global data', async () => {
    setCurrentRegion('sg');

    await projectsApi.get('p1');
    await notificationsApi.count();
    await request.get('/users', { params: { ids: 'a,b' } });

    expect(seen).toEqual([`${SG}/projects/p1`, `${US}/users/me/notifications/count`, `${SG}/users`]);
  });

  it('go to the global region when the open Studio has no region', async () => {
    setCurrentRegion(null);

    await projectsApi.get('p1');

    expect(seen).toEqual([`${US}/projects/p1`]);
  });

  it('keep the same-origin address in a build with no region table', async () => {
    vi.mocked(getRegionConfig).mockReturnValue(null);
    setCurrentRegion('sg');

    await projectsApi.get('p1');

    expect(seen).toEqual(['/api/v1/projects/p1']);
  });
});

describe('creating a Project', () => {
  it('goes to the region of the Studio it is created in, whatever page is open', async () => {
    setCurrentRegion(null);
    await projectsApi.create({ studioId: 's-sg', name: 'P', slug: 'pppppp', spaceType: 'canvas' }, 'key-1', 'sg');
    setCurrentRegion('sg');
    await projectsApi.create({ studioId: 's-us', name: 'P', slug: 'pppppp', spaceType: 'canvas' }, 'key-2', null);

    expect(seen).toEqual([`${SG}/projects`, `${US}/projects`]);
  });
});

describe('the streaming wrapper', () => {
  it('opens a relative stream on the current region', async () => {
    setCurrentRegion('sg');

    await sseStream({ url: '/mini-tools/text', body: {}, parseEvent: () => null, onEvent: () => undefined });

    expect(fetchEventSource.mock.calls[0]![0]).toBe(`${SG}/mini-tools/text`);
  });
});

describe('the Agent chat send', () => {
  it('posts to the region of its Project when another page is open', async () => {
    rememberProjectRegion('p-chat-sg', 'sg');
    setCurrentRegion(null);

    await chatApi.sendMessage({ project_id: 'p-chat-sg', message: 'hello' }, 'key-1', 'p-chat-sg');

    expect(seen.at(-1)).toBe(`${SG}/chat/message`);
  });

  // A body over the request limit goes as a reference that names no Project.
  it('posts a stored body to the region of its Project too', async () => {
    rememberProjectRegion('p-chat-sg', 'sg');
    setCurrentRegion(null);

    await chatApi.sendMessage({ transfer: 'transfer/abc' }, 'key-2', 'p-chat-sg');

    expect(seen.at(-1)).toBe(`${SG}/chat/message`);
  });
});

describe('decision links', () => {
  it('go to the region a prefixed token names, whatever page is open', async () => {
    setCurrentRegion(null);

    await decisionsApi.view('sg.abc');

    expect(seen).toEqual([`${SG}/decisions/sg.abc`]);
  });

  it('go to the global region for a prefix the table does not name', async () => {
    setCurrentRegion('sg');

    await decisionsApi.view('mars.abc');

    expect(seen).toEqual([`${US}/decisions/mars.abc`]);
  });

  it('go to the global region for a token with no prefix', async () => {
    setCurrentRegion('sg');

    await decisionsApi.view('abc');

    expect(seen).toEqual([`${US}/decisions/abc`]);
  });
});

describe('an upload', () => {
  it('sends its finish, status poll and failure report to the region that opened it, after the page moved', async () => {
    setCurrentRegion('sg');
    const ticket = (await assetsApi.requestUploadTicket({
      filename: 'a.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: 1,
      hash: 'a'.repeat(64),
    })) as UploadTicket;
    setCurrentRegion(null);

    const cfg = { maxBytes: 10, clientMaxAttempts: 1, clientRetryBaseDelayMs: 0, partIdleTimeoutMs: 1000 };
    await sendFileAndFinish(new Blob(['x']), ticket, cfg as never);
    await assetsApi.fetchUploadStatus(['k1'], ticket.apiBase);
    await canvasApi.reportNodeTaskFailure('t1', ticket.apiBase);

    expect(seen).toEqual([
      `${SG}/assets/upload-ticket`,
      `${SG}/assets/uploads/up1/complete`,
      `${SG}/assets/upload-status`,
      `${SG}/canvas/node-tasks/t1/failure`,
    ]);
  });
});

describe('a request acting on a Project or Studio', () => {
  it('goes to its region whichever page is open when it is sent', async () => {
    rememberProjectRegion('p-sg', 'sg');
    rememberStudioRegion(['s-sg', 'sg-handle'], 'sg');
    setCurrentRegion(null);

    await projectsApi.get('p-sg');
    await apiPost('/mini-tools', { project_id: 'p-sg' });
    await request.get('/canvas/limits', { params: { project_id: 'p-sg' } });
    await studiosApi.get('sg-handle');
    await assetsApi.requestUploadTicket({ filename: 'a.png', contentType: 'image/png', studioId: 's-sg', purpose: 'studio_avatar', size: 1, hash: 'a'.repeat(64) });
    await documentsApi.save({ projectId: 'p-sg', spaceId: 'sp' }, { name: undefined, content: {}, schemaVersion: '1' });
    await canvasApi.paste({ project_id: 'p-sg', urls: [], pairs: [], history: [] });
    await canvasApi.snapshotNodeText({ project_id: 'p-sg', node_id: 'n', text: 'x' });

    expect(seen).toEqual([
      `${SG}/projects/p-sg`,
      `${SG}/mini-tools`,
      `${SG}/canvas/limits`,
      `${SG}/studio/sg-handle`,
      `${SG}/assets/upload-ticket`,
      `${SG}/documents/versions`,
      `${SG}/canvas/paste`,
      `${SG}/canvas/node-history/snapshot`,
    ]);
  });

  it('goes to the open page region when it names nothing this tab knows', async () => {
    setCurrentRegion('sg');

    await projectsApi.get('p-unknown');
    await apiPost('/mini-tools', { project_id: 'p-unknown' });

    expect(seen).toEqual([`${SG}/projects/p-unknown`, `${SG}/mini-tools`]);
  });
});
