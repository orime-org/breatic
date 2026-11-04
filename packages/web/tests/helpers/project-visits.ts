// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect, type Page, type Request, type Response } from 'playwright/test';
import type { AccountActivityKind, ProjectVisitLookup, ProjectVisitOpened, ProjectVisitReceipt, ProjectVisitRequest } from '@breatic/shared';
import type * as YjsManagerModule from '@web/data/yjs/manager';
import type * as CollabSocketModule from '@web/data/yjs/collab-socket';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { test } from './slot';
import { dataOf } from './api';
import { liveModuleUrl, YJS_MANAGER } from './live-module';

/** The agreed wire receipt; the browser must not invent a second response shape. */
export type VisitReceipt = ProjectVisitReceipt;
/** The recorded branch of the shared original-result response. */
export type RecordedVisitLookup = Extract<ProjectVisitLookup, { status: 'recorded' }>;

/** A browser's actual access submissions, independent of React internals. */
export interface VisitTraffic { posts: Array<{ projectId: string; visitId: string; observedAt: string }>; stop: () => void }

/** Observe actual opened submissions without replacing their execution. @throws {never} Never. */
export function watchVisits(page: Page): VisitTraffic {
  const posts: VisitTraffic['posts'] = [];
  /** Capture only the protocol under test. @throws {Error} If the browser sends invalid JSON. */
  function observe(request: Request): void {
    const match = /\/api\/v1\/projects\/([^/]+)\/opened$/.exec(new URL(request.url()).pathname);
    if (request.method() !== 'POST' || match === null) return;
    const body = request.postDataJSON() as ProjectVisitRequest;
    posts.push({ projectId: match[1], visitId: body.visit_id ?? '', observedAt: new Date().toISOString() });
  }
  page.on('request', observe);
  return { posts, stop: () => { page.off('request', observe); } };
}

/** Persist evidence even with the list reporter, then link it as a test artifact. @throws {Error} When the artifact cannot be written. */
export async function saveVisitEvidence(name: string, value: unknown): Promise<void> {
  const path = test.info().outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { path, contentType: 'application/json' });
}

/** Persist the actual rendered screen before attaching it. @throws {Error} When capture or writing fails. */
export async function saveVisitScreenshot(page: Page, name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await writeFile(path, await page.screenshot());
  await test.info().attach(name, { path, contentType: 'image/png' });
}

/** A minimal owned-project database snapshot, with no user profile or content. */
export interface VisitDbSnapshot { events: Array<{ kind: AccountActivityKind; visit_id: string | null; occurred_at: string }> }

/** Read actual persisted events using the configured root bootstrap, without reading env files. @throws {Error} When ownership or DB inspection fails. */
export async function inspectVisitDb(receipt: VisitReceipt): Promise<VisitDbSnapshot> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', '--tsconfig', 'packages/server/tsconfig.json', 'scripts/inspect-smoke-project-visits.ts'], {
      cwd: resolve(__dirname, '../../../..'), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => { if (code === 0) resolveOutput(stdout); else reject(new Error(`Owned visit DB inspection failed (${code}): ${stderr}`)); });
    child.stdin.end(JSON.stringify({ accountId: receipt.account_id, projectId: receipt.project_id, visitId: receipt.visit_id }));
  });
  return JSON.parse(output) as VisitDbSnapshot;
}

/** Wait for a real page-entry response. @throws {Error} When the original request never finishes. */
export function nextVisit(page: Page, projectId: string): Promise<Response> {
  return page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/opened`);
}

/** Read and validate a matching persisted receipt. @throws {Error} When the server refuses or mismatches it. */
export async function readVisit(response: Pick<Response, 'ok' | 'status' | 'text' | 'json'>, projectId: string): Promise<VisitReceipt> {
  const result = await dataOf<ProjectVisitOpened>(response, 'actual page entry');
  expect(result.ok).toBe(true);
  expect(result.project_id).toBe(projectId);
  expect(result.visit_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(Number.isNaN(Date.parse(result.occurred_at))).toBe(false);
  return { account_id: result.account_id, project_id: result.project_id, visit_id: result.visit_id, occurred_at: result.occurred_at };
}

/** Reconnect the existing real transport, retaining its live Yjs document. @throws {Error} When no live Project exists. */
export async function reconnectProject(page: Page, projectId: string): Promise<void> {
  const urls = { manager: await liveModuleUrl(page, YJS_MANAGER), socket: await liveModuleUrl(page, 'data/yjs/collab-socket.tsx') };
  await Promise.all([page.waitForEvent('websocket'), page.evaluate(async ({ urls, projectId }) => {
    const manager = await import(/* @vite-ignore */ urls.manager) as typeof YjsManagerModule;
    const socket = await import(/* @vite-ignore */ urls.socket) as typeof CollabSocketModule;
    const name = manager.docName.projectMeta(projectId);
    if (!manager.hasDoc(name)) throw new Error('The real Project meta document is absent');
    const provider = socket.acquireDocProvider(name, manager.getDoc(name));
    try {
      const transport = provider.configuration.websocketProvider;
      const closed = new Promise<void>((resolve) => {
        /** Detach the finite close observer. @throws {never} Never. */
        const onClose = (): void => { transport.off('close', onClose); resolve(); };
        transport.on('close', onClose);
      });
      transport.disconnect(); await closed; await transport.connect();
    } finally { socket.releaseDocProvider(name); }
  }, { urls, projectId })]);
}
