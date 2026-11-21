// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResolvedVideoPresentation } from '../use-resolved-video-presentation';
import { videoPresentationQuery } from '../video-presentation-query';
import { PRESENTED, presentedBinding, presentedBundle, presentedPreparation, presentedResponse } from '@web/test-utils/video-presentation';

// §96 (frames-split design §3.5 alpha manifest row, §7.8): a selected alpha-packed bundle plays from its manifest object,
// which names the packed carrier and the logical colour and alpha rectangles. The resolver reads the manifest the bundle's
// receipt measures, holds it to the version (`alphaPackedManifestMatchesVersion`: its packed object is the version's carrier)
// and only then yields a playable source; a manifest naming another packed object yields none.
const projectId = 'project-a';
const url = 'https://assets.example.test/video/alpha.webm';
const carrier = { storageKey: 'video/alpha.webm.packed.mp4', url: 'https://assets.example.test/video/alpha.webm.packed.mp4', etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
const manifestURL = 'https://assets.example.test/video/alpha.webm.manifest.json';
const manifest = { schemaVersion: 1,
  packed: carrier, packedWidth: 196, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 100, y: 0, width: 96, height: 64 } };
const fetchMock = vi.fn<typeof fetch>();
let client: QueryClient;

/**
 * The SHA-256 hex of some bytes.
 * @param bytes - The bytes.
 * @returns Their digest.
 */
async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Seed the read with an alpha-packed bundle whose manifest receipt measures the given manifest, and serve that manifest.
 * @param served - The manifest object at the receipt's URL.
 * @returns Nothing.
 */
async function seed(served: Record<string, unknown>): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(served));
  const receipt = { storageKey: 'video/alpha.webm.manifest.json', url: manifestURL, etag: '"manifest"', size: bytes.length, sha256: await sha256(bytes), contentType: 'application/json' };
  const bundle = presentedBundle(url, { playback: { kind: 'alpha-packed', carrier, manifest: receipt } });
  const response = presentedResponse(presentedBinding(url, { width: 96, height: 64, duration: 3, mimeType: 'video/webm' }), { presentation: bundle });
  const options = videoPresentationQuery({ projectId, canonicalURL: url, active: true });
  client.setQueryDefaults(options.queryKey, { staleTime: Infinity });
  client.setQueryData(options.queryKey, response);
  fetchMock.mockImplementation(async (input) => String(input instanceof Request ? input.url : input) === manifestURL
    ? new Response(bytes, { headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } }) : new Response(null, { status: 404 }));
}

/**
 * Render the resolver under the seeded client.
 * @returns The hook's result.
 */
function resolve(): ReturnType<typeof renderHook<ReturnType<typeof useResolvedVideoPresentation>, unknown>> {
  return renderHook(() => useResolvedVideoPresentation(projectId, url, true), {
    wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });

describe('an alpha-packed selected version plays from its manifest (§96; design §3.5, §7.8)', () => {
  it('AP01 reads the manifest the bundle measures and yields a source carrying it', async () => {
    await seed(manifest);
    const { result } = resolve();
    await waitFor(() => expect(result.current.source).not.toBeNull());
    expect(fetchMock.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input))).toEqual([manifestURL]);
    expect(result.current.source).toMatchObject({ canonicalURL: url, sourceFingerprint: PRESENTED.fingerprint, manifest });
    expect(result.current.failure).toBeNull();
  });

  it('AP02 a manifest of another version yields no playable source', async () => {
    await seed({ ...manifest, packed: { ...carrier, sha256: 'b'.repeat(64) } });
    const { result } = resolve();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.source).toBeNull();
  });
});

describe('the source keeps its identity while the selected version is unchanged (frames-split §7.8 Replace)', () => {
  it('RV03 a response whose preparation changes beside the same selected P keeps the same source object', async () => {
    const options = videoPresentationQuery({ projectId, canonicalURL: url, active: true });
    client.setQueryDefaults(options.queryKey, { staleTime: Infinity });
    const binding = presentedBinding(url);
    client.setQueryData(options.queryKey, presentedResponse(binding, { presentation: presentedBundle(url), preparation: presentedPreparation(null, 'plan') }));
    const { result, rerender } = resolve();
    const first = result.current.source;
    expect(first).not.toBeNull();
    client.setQueryData(options.queryKey, presentedResponse(binding, { presentation: presentedBundle(url), preparation: presentedPreparation(null, 'encode') }));
    rerender();
    await waitFor(() => expect(result.current.query.data?.preparation?.stage).toBe('encode'));
    expect(result.current.source).toBe(first);
  });
});
