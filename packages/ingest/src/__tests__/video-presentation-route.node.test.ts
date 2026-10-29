// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The backend presentation boundary hands the store the whole admission the
 * backend sent, including the source ledger v2 request (inner#1306 test plan
 * §77, I01). The Durable Object and bucket are stand-ins; what is under test is
 * the mapping from the validated body to the admission.
 */

import { describe, expect, it, vi } from 'vitest';

import { videoPresentationRoute, type VideoPresentationEnv } from '@ingest/video-presentation-route.js';

const ledgerLimits = { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 };
const accept = {
  action: 'accept', storageKey: 'video/canonical.webm', sourceFingerprint: 'a'.repeat(64), jobId: 'video-presentation-a', deadlineAt: 1900000000000,
  original: null, contentType: 'video/webm',
  limits: { maxSourceBytes: 1, maxPackedBytes: 1, crf: 18, preset: 'medium', probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1, sourceLedger: ledgerLimits },
  pricing: { containerClass: 'MediaContainer', size: { vcpu: 1, memory_gib: 1, disk_gb: 1 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } },
  actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
  packedURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.mp4', manifestURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.json',
  sourceLedgerURL: 'https://assets.example.test/video/canonical.webm.ledger.json',
  sourceLedgerTableURL: 'https://assets.example.test/video/canonical.webm.table.json',
};

describe('presentation admission at the ingest boundary (inner#1306 §77)', () => {
  it('I01 passes the ledger budgets and both companion URLs through to the store', async () => {
    const acceptPresentation = vi.fn(async () => ({ presentation: null, attempt: null }));
    const env = {
      INGEST_SHARED_SECRET: 'secret',
      BUCKET: { head: async () => ({ etag: 'e' }) },
      MEDIA: { idFromName: (name: string) => name, get: () => ({ acceptPresentation }) },
    } as unknown as VideoPresentationEnv;
    const response = await videoPresentationRoute(new Request('https://ingest.example.test/video-presentation', {
      method: 'POST', headers: { 'x-ingest-secret': 'secret', 'content-type': 'application/json' }, body: JSON.stringify(accept),
    }), env);
    expect(response.status).toBe(200);
    expect(acceptPresentation).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({ sourceLedger: ledgerLimits }),
      sourceLedgerURL: accept.sourceLedgerURL,
      sourceLedgerTableURL: accept.sourceLedgerTableURL,
    }));
  });
});
