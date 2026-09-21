// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { afterEach, expect, it, vi } from 'vitest';
const transports = vi.hoisted(() => ({ socket: vi.fn(), stream: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@hocuspocus/provider', () => ({ HocuspocusProviderWebsocket: class {
  constructor(config: unknown) { transports.socket(config); }
  destroy() { }
}, HocuspocusProvider: class {
  attach() { }
  on() { }
  destroy() { }
} }));
vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource: transports.stream }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });
it('uses the configured backend for API, streams and download links', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://backend.example.com/api/v1/');
  const { request } = await import('../api/request');
  const { downloadHref } = await import('../api/download-href');
  const { textToolsApi } = await import('../api/text-tools');
  expect(request.defaults.baseURL).toBe('https://backend.example.com/api/v1');
  expect(request.defaults.withCredentials).toBe(true);
  expect(downloadHref('https://media.example.com/a')).toBe('https://backend.example.com/api/v1/assets/download?url=https%3A%2F%2Fmedia.example.com%2Fa');
  await textToolsApi.stream({ toolId: 'polish', document: 'text' }, { onEvent: () => undefined });
  expect(transports.stream.mock.calls[0]?.[0]).toBe('https://backend.example.com/api/v1/mini-tools/text');
  expect(transports.stream.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
});
it('uses the configured WebSocket host', async () => {
  vi.stubEnv('VITE_COLLAB_URL', 'wss://backend.example.com/ws');
  const m = await import('../yjs/collab-socket');
  const Y = await import('yjs');
  m.acquireDocProvider('project-p1/meta', new Y.Doc());
  expect(transports.socket).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://backend.example.com/ws' }));
  m._resetCollabSocketForTests();
});
it('keeps the local API default when configuration is empty', async () => {
  vi.stubEnv('VITE_API_BASE_URL', '');
  expect((await import('../api/base-path')).API_BASE_PATH).toBe('/api/v1');
});
