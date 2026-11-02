// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectRegisteredAsset, TimelineClientLimits } from '@breatic/shared';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Doc } from 'yjs';
import { expect, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright/test';

import { dataOf } from './api';
import { credentialsFor } from './credentials';
import { liveModuleUrl, YJS_MANAGER } from './live-module';
import { stateFile } from './slot';
import { visibleSpace } from './space';
import { roomForUploads } from './upload-budget';

/** A real local upload and the placement created by accepting it. */
export interface TimelineUpload {
  asset: ProjectRegisteredAsset;
  clipId: string;
  durationFrames: number;
  durationSeconds: number;
  fps: TimelineClientLimits['defaults']['fps'];
}

/** Errors observed outside the deliberately disconnected transport scope. */
export interface TimelineErrors {
  unexpected: string[];
  offline: boolean;
  mediaUrls: Set<string>;
}

/**
 * Observe real browser errors without suppressing page exceptions, including offline.
 * @throws {never} Never.
 */
export function watchTimelineErrors(page: Page): TimelineErrors {
  const observed: TimelineErrors = { unexpected: [], offline: false, mediaUrls: new Set() };
  const sockets = new Set<string>();
  page.on('websocket', (socket) => sockets.add(socket.url()));
  page.on('pageerror', (error) => observed.unexpected.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const url = message.location().url;
    const explicitDisconnect = observed.offline
      && url.includes('/data/yjs/collab-failure-report.ts')
      && /^\[collab\] collab disconnect(?: \(close (?:1000|1005|1006)\))?(?: |$)/.test(text);
    const knownNetworkTarget = observed.mediaUrls.has(url) || sockets.has(url)
      || (url.startsWith(new URL(page.url()).origin) && new URL(url).pathname.startsWith('/api/'));
    const offlineNetwork = observed.offline && knownNetworkTarget && text.includes('net::ERR_INTERNET_DISCONNECTED');
    if (!explicitDisconnect && !offlineNetwork) observed.unexpected.push(`console: ${text} (${url})`);
  });
  return observed;
}

/**
 * Open the existing Timeline through the same drawer and tab controls as other Spaces.
 * @throws {Error} When the requested Timeline cannot be opened.
 */
export async function openTimeline(page: Page, spaceId: string): Promise<void> {
  const tab = page.getByTestId(`space-tab-name-${spaceId}`);
  if (await tab.count() === 0) {
    await page.getByTestId('space-drawer-trigger').click();
    const drawer = page.getByTestId('space-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button', { name: /Open/ }).click();
    await expect(drawer).toHaveCount(0);
  } else {
    await tab.click();
  }
  await expect(visibleSpace(page).getByTestId('timeline-space')).toHaveAttribute('data-space-id', spaceId);
}

/**
 * Read placement identities from the visible track rather than a second app-module instance.
 * @throws {Error} When the visible track cannot be read.
 */
export async function timelineClipIds(page: Page): Promise<string[]> {
  return visibleSpace(page).locator('[data-testid^="timeline-clip-"]').evaluateAll((clips) =>
    clips.map((clip) => clip.getAttribute('data-testid')!.replace('timeline-clip-', '')),
  );
}

/**
 * Select a placement through its track or, for overlapping placements, its conflict row.
 * @throws {Error} When the placement is missing or its properties never appear.
 */
export async function selectTimelineClip(page: Page, clipId: string): Promise<void> {
  const outlet = visibleSpace(page);
  const conflict = outlet.getByTestId(`timeline-conflict-${clipId}`);
  const button = await conflict.count() > 0 ? conflict : outlet.getByTestId(`timeline-clip-${clipId}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Assert the selected placement's integer-frame position using the actual properties text.
 * @throws {Error} When the displayed position differs from the expected placement.
 */
export async function expectTimelineStart(page: Page, clipId: string, start: number, duration: number): Promise<void> {
  await selectTimelineClip(page, clipId);
  await expect(visibleSpace(page).getByText(`Start ${start} · Duration ${duration} frames`, { exact: true }).last()).toBeVisible();
}

/**
 * Move a placement through the native start-frame form and wait for the accepted position.
 * @throws {Error} When the real edit is refused or does not reach the properties view.
 */
export async function moveTimelineClip(page: Page, clipId: string, start: number, duration: number): Promise<void> {
  const outlet = visibleSpace(page);
  await selectTimelineClip(page, clipId);
  await outlet.getByTestId('timeline-edit-start').click();
  await outlet.getByTestId('timeline-start-frame').fill(String(start));
  await outlet.getByTestId('timeline-apply-start').click();
  await expect(outlet.getByTestId('timeline-apply-start')).toHaveCount(0);
  await expectTimelineStart(page, clipId, start, duration);
}

/**
 * Wait for the registered source to load and decode through the real native video element.
 * @throws {Error} When authorized media cannot produce a decoded frame.
 */
export async function expectTimelineVideoReady(page: Page, fileUrl: string): Promise<void> {
  const video = visibleSpace(page).getByTestId('timeline-preview').locator('video');
  await expect(video).toHaveAttribute('src', fileUrl);
  expect(new URL(fileUrl).protocol).toMatch(/^https?:$/);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
    decoded: element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0,
    error: element.error?.code ?? null,
  })), { timeout: 60_000 }).toEqual({ decoded: true, error: null });
}

/**
 * Identify the ticket, ingest transfer and finish/status requests used by this upload.
 * @throws {never} Never; browser request URLs are already absolute URLs.
 */
function isTimelineUploadRequest(request: Request): boolean {
  const path = new URL(request.url()).pathname;
  return path === '/api/v1/assets/upload-ticket' || path === '/api/v1/assets/upload-status'
    || /(?:^|\/)uploads(?:\/|$)/.test(path);
}

/**
 * Upload the repository's real MP4 through Timeline's unmodified upload and authorization APIs.
 * @param fixturePath - The existing MP4 fixture to upload; defaults to the ordinary Timeline sample.
 * @throws {Error} When upload, canonical resolution, placement acceptance or decoding fails.
 */
export async function uploadTimelineVideo(page: Page, projectId: string, fixturePath = resolve(__dirname, '../fixtures/media-history.mp4')): Promise<TimelineUpload> {
  const outlet = visibleSpace(page);
  await expect(outlet.getByTestId('timeline-space-empty')).toBeVisible();
  const { defaults: { fps } } = await dataOf<TimelineClientLimits>(
    await page.request.get(`/api/v1/projects/${projectId}/timeline-limits`),
    'read the authorized frame rate used to create this fresh Timeline',
  );
  await outlet.getByTestId('timeline-add-media').click();
  const dialog = page.getByRole('dialog', { name: 'Add media', exact: true });
  await dialog.getByTestId('timeline-material-local').click();
  // openSmokeProject watches this same ticket endpoint, including requests without a canvas node.
  await roomForUploads(1);
  await dialog.getByTestId('timeline-file-input').setInputFiles({
    name: `timeline-${crypto.randomUUID()}.mp4`,
    mimeType: 'video/mp4',
    buffer: readFileSync(fixturePath),
  });
  const observation: { response?: Response; failure?: string } = {};
  /** Record failures without including upload tokens, request bodies or signed query parameters. */
  const onFailed = (request: Request): void => {
    if (!isTimelineUploadRequest(request)) return;
    const url = new URL(request.url());
    observation.failure ??= `${request.method()} ${url.origin}${url.pathname}: ${request.failure()?.errorText ?? 'request failed'}`;
  };
  /** Observe the browser's real response, rather than treating it as an APIRequestContext response. */
  const onResponse = (response: Response): void => {
    const request = response.request();
    const url = new URL(response.url());
    const authorized = request.method() === 'GET' && url.pathname.startsWith(`/api/v1/projects/${projectId}/assets/`);
    if (authorized) observation.response = response;
    if (response.status() >= 400 && (authorized || isTimelineUploadRequest(request))) {
      observation.failure ??= `${request.method()} ${url.origin}${url.pathname}: HTTP ${response.status()}`;
    }
  };
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  let asset: ProjectRegisteredAsset;
  try {
    await dialog.getByTestId('timeline-confirm-material').click();
    await expect.poll(async () => {
      const error = dialog.getByTestId('timeline-material-error');
      if (await error.isVisible()) observation.failure ??= `Timeline upload: ${await error.innerText()}`;
      return observation.failure !== undefined ? 'failed' : observation.response !== undefined ? 'authorized' : 'waiting';
    }, {
      // Match watchQueuedFinish's asynchronous registration budget; transfer failures still terminate immediately.
      timeout: 120_000,
      message: 'Timeline upload must authorize the registered asset or report its transfer failure',
    }).not.toBe('waiting');
    expect(observation.failure, 'Timeline upload failed before Project asset authorization').toBeUndefined();
    const response = observation.response;
    if (response === undefined) throw new Error('Timeline upload ended without a Project asset response');
    expect(response.ok(), `resolve uploaded Project video: HTTP ${response.status()} ${await response.text()}`).toBe(true);
    const envelope = await response.json() as { data: ProjectRegisteredAsset };
    asset = envelope.data;
  } finally {
    page.off('requestfailed', onFailed);
    page.off('response', onResponse);
  }
  expect(asset.kind).toBe('video');
  expect(asset.assetId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(outlet.locator('[data-testid^="timeline-clip-"]')).toHaveCount(1);
  const [clipId] = await timelineClipIds(page);
  await selectTimelineClip(page, clipId);
  const properties = await outlet.getByText(/^Start 0 · Duration \d+ frames$/).innerText();
  const durationFrames = Number(/Duration (\d+) frames/.exec(properties)?.[1]);
  expect(Number.isSafeInteger(durationFrames)).toBe(true);
  expect(durationFrames).toBeGreaterThan(0);
  await expectTimelineVideoReady(page, asset.fileUrl);
  const durationSeconds = await outlet.getByTestId('timeline-preview').locator('video').evaluate((element: HTMLVideoElement) => element.duration);
  expect(durationSeconds).toBeGreaterThan(0);
  return { asset, clipId, durationFrames, durationSeconds, fps };
}

/**
 * Add another independent placement of the registered upload through the Project video picker.
 * @throws {Error} When the Project catalog cannot select or accept the same registered asset.
 */
export async function addProjectTimelineVideo(page: Page, assetId: string): Promise<string> {
  const before = await timelineClipIds(page);
  await visibleSpace(page).getByTestId('timeline-add-media').click();
  const dialog = page.getByRole('dialog', { name: 'Add media', exact: true });
  await dialog.getByTestId('timeline-material-project').click();
  const choice = dialog.getByTestId(`timeline-project-video-${assetId}`);
  const more = dialog.getByRole('button', { name: 'Load more', exact: true });
  const choices = dialog.locator('[data-testid^="timeline-project-video-"]');
  for (;;) {
    // Cached empty data can remain visible while the post-upload invalidation fetch completes.
    await expect(choice.or(more).first()).toBeVisible();
    if (await choice.count() > 0) break;
    const previousCount = await choices.count();
    const pageLoaded = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname.endsWith('/assets') && new URL(response.url()).searchParams.has('cursor'));
    await more.click();
    expect((await pageLoaded).ok()).toBe(true);
    await expect.poll(async () => await choices.count() > previousCount || await more.count() === 0).toBe(true);
  }
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByTestId('timeline-confirm-material').click();
  await expect(dialog).toHaveCount(0);
  await expect(visibleSpace(page).locator('[data-testid^="timeline-clip-"]')).toHaveCount(before.length + 1);
  const added = (await timelineClipIds(page)).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  return added[0];
}

/**
 * Use actual slot-B membership, restore an existing role, and remove only invitations made here.
 * @throws {Error} When the real invitation, role change, callback or cleanup fails.
 */
export async function withTimelinePeer(
  owner: Page, browser: Browser, projectId: string, role: 'viewer' | 'editor',
  run: (peer: Page, context: BrowserContext) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ storageState: stateFile('B'), baseURL: new URL(owner.url()).origin });
  const peer = await context.newPage();
  const path = `/api/v1/projects/${projectId}`;
  const me = await dataOf<{ id: string }>(await peer.request.get('/api/v1/auth/me'), 'read slot B identity');
  const members = await dataOf<{ userId: string; role: string }[]>(await owner.request.get(`${path}/members`), 'read original Project membership');
  const original = members.find((member) => member.userId === me.id);
  const invitations = await dataOf<{ invitationId: string; email: string }[]>(await owner.request.get(`${path}/invitations`), 'read original invitations');
  const previous = new Set(invitations.map((invitation) => invitation.invitationId));
  try {
    if (original === undefined) {
      await dataOf(await owner.request.post(`${path}/invitations`, { data: { email: credentialsFor('B').email, role } }), 'invite slot B');
      let token: string | undefined;
      await expect.poll(async () => {
        const bell = await dataOf<{ items: { type: string; payload: { shareToken?: string; projectId?: string } }[] }>(
          await peer.request.get('/api/v1/users/me/notifications'), 'read slot B invitation',
        );
        token = bell.items.find((item) => item.type === 'project.invite_request' && item.payload.projectId === projectId)?.payload.shareToken;
        return token;
      }).toBeDefined();
      await dataOf(await peer.request.post('/api/v1/decisions/respond', { data: { token, action: 'confirm' } }), 'accept slot B invitation');
    } else {
      expect(original.role).toMatch(/^(viewer|editor)$/);
      await dataOf(await owner.request.patch(`${path}/members/${me.id}`, { data: { role } }), 'set slot B Project role');
    }
    const joined = await dataOf<{ userId: string; role: string }[]>(await owner.request.get(`${path}/members`), 'verify slot B Project role');
    expect(joined.find((member) => member.userId === me.id)?.role).toBe(role);
    await run(peer, context);
  } finally {
    await context.setOffline(false);
    await context.close();
    const current = await dataOf<{ userId: string }[]>(await owner.request.get(`${path}/members`), 'read membership for restoration');
    if (current.some((member) => member.userId === me.id)) {
      if (original === undefined) await dataOf(await owner.request.delete(`${path}/members/${me.id}`), 'remove the membership created here');
      else await dataOf(await owner.request.patch(`${path}/members/${me.id}`, { data: { role: original.role } }), 'restore slot B Project role');
    }
    const pending = await dataOf<{ invitationId: string; email: string }[]>(await owner.request.get(`${path}/invitations`), 'read invitations for cleanup');
    for (const invitation of pending.filter((item) => item.email === credentialsFor('B').email && !previous.has(item.invitationId))) {
      await dataOf(await owner.request.delete(`${path}/invitations/${invitation.invitationId}`), 'revoke the invitation created here');
    }
  }
}

/**
 * Drive the existing shared socket with a balanced temporary meta-provider reference.
 * @throws {Error} When this context's live Project metadata or transport is missing.
 */
export async function setTimelineConnection(page: Page, projectId: string, spaceId: string, connected: boolean): Promise<void> {
  const urls = {
    manager: await liveModuleUrl(page, YJS_MANAGER),
    socket: await liveModuleUrl(page, 'data/yjs/collab-socket.tsx'),
  };
  const status = await page.evaluate(async ({ urls, projectId, spaceId, connected }) => {
    const manager = await import(/* @vite-ignore */ urls.manager) as {
      hasDoc: (name: string) => boolean;
      getDoc: (name: string) => Doc;
      docName: { projectMeta: (id: string) => string };
    };
    const socket = await import(/* @vite-ignore */ urls.socket) as {
      acquireDocProvider: (name: string, doc: Doc) => HocuspocusProvider;
      releaseDocProvider: (name: string) => void;
    };
    const name = manager.docName.projectMeta(projectId);
    if (name !== `project-${projectId}/meta` || !manager.hasDoc(name)) throw new Error('The current Project meta document is missing');
    const doc = manager.getDoc(name);
    if (doc.getMap('spaces').size === 0 || !doc.getMap('spaces').has(spaceId)) throw new Error('The live Project metadata does not contain this Timeline');
    const provider = socket.acquireDocProvider(name, doc);
    try {
      const transport = provider.configuration.websocketProvider;
      if (connected) await transport.connect();
      else {
        const closed = transport.webSocket === null ? Promise.resolve() : new Promise<void>((resolve) => {
          /** Resolve only after this actual shared socket closes. */
          const onClose = (): void => { transport.off('close', onClose); resolve(); };
          transport.on('close', onClose);
        });
        transport.disconnect();
        await closed;
      }
      return transport.status;
    } finally {
      socket.releaseDocProvider(name);
    }
  }, { urls, projectId, spaceId, connected });
  expect(status).toBe(connected ? 'connected' : 'disconnected');
  if (connected) await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  else await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-status', 'disconnected');
}
