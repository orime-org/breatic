// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';

import {
  isReportableAssetUrl,
  fileToNodeSpec,
  fillNodeFromFile,
  runMediaUpload,
  computeDeletedAssetEntries,
  assetUrlSurvives,
} from '@web/spaces/canvas/canvas-upload';

describe('fileToNodeSpec — MIME → which node + whether to upload', () => {
  it('routes images to an image node that needs uploading', () => {
    expect(fileToNodeSpec({ type: 'image/png' })).toEqual({
      nodeType: 'image',
      needsUpload: true,
    });
  });

  it('routes video / audio to their media nodes (need upload)', () => {
    expect(fileToNodeSpec({ type: 'video/mp4' })).toEqual({
      nodeType: 'video',
      needsUpload: true,
    });
    expect(fileToNodeSpec({ type: 'audio/mpeg' })).toEqual({
      nodeType: 'audio',
      needsUpload: true,
    });
  });

  it('routes text files to a text node (no upload — content read/extracted locally)', () => {
    expect(fileToNodeSpec({ type: 'text/plain' })).toEqual({
      nodeType: 'text',
      needsUpload: false,
    });
    expect(fileToNodeSpec({ type: 'text/markdown' })).toEqual({
      nodeType: 'text',
      needsUpload: false,
    });
  });

  it('routes EVERY non-media file to a text node (pdf/docx/xlsx/binary — extracted, never rejected)', () => {
    const text = { nodeType: 'text', needsUpload: false };
    expect(fileToNodeSpec({ type: 'application/pdf' })).toEqual(text);
    expect(
      fileToNodeSpec({
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toEqual(text);
    expect(
      fileToNodeSpec({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toEqual(text);
    expect(fileToNodeSpec({ type: 'application/octet-stream' })).toEqual(text);
    expect(fileToNodeSpec({ type: '' })).toEqual(text);
  });
});

/** The knob fixture threaded through the upload orchestration tests. */
const CFG = {
  maxUploadBytes: 2147483648,
  clientMaxAttempts: 3,
  clientRetryBaseDelayMs: 1000,
  clientRequestTimeoutMs: 30000,
  clientPutMinBytesPerSec: 65536,
};

const HASH = 'a'.repeat(64);

/** Shared orchestration deps (config + hash + network spies). */
function makeUploadDeps(
  over: Partial<Parameters<typeof runMediaUpload>[2]> = {},
): Parameters<typeof runMediaUpload>[2] {
  return {
    getUploadConfig: vi.fn().mockResolvedValue(CFG),
    hashFile: vi.fn().mockResolvedValue(HASH),
    presign: vi.fn().mockResolvedValue({
      uploadUrl: 'https://put',
      fileUrl: 'https://cdn/p.png',
      key: 'k',
      kind: 'image',
    }),
    putFile: vi.fn().mockResolvedValue(undefined),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

describe('runMediaUpload — config → hash → presign(dedup) → PUT → callbacks', () => {
  const file = new File(['x'], 'photo.png', { type: 'image/png' });

  it('presigns with name + type + size + hash, PUTs with the config, reports the URL', async () => {
    const deps = makeUploadDeps();
    const onUploaded = vi.fn();

    await runMediaUpload(file, 'p1', { ...deps, onUploaded });

    expect(deps.presign).toHaveBeenCalledWith({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: file.size,
      hash: HASH,
    });
    expect(deps.putFile).toHaveBeenCalledWith('https://put', file, CFG);
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith('https://cdn/p.png');
    expect(onUploaded).toHaveBeenCalledExactlyOnceWith({
      key: 'k',
      kind: 'image',
      fileUrl: 'https://cdn/p.png',
      hash: HASH,
    });
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('dedup hit: skips the PUT entirely and reuses the existing URL (B.2)', async () => {
    const deps = makeUploadDeps({
      presign: vi.fn().mockResolvedValue({
        alreadyExists: true,
        fileUrl: 'https://cdn/existing.png',
        kind: 'image',
      }),
    });
    const onUploaded = vi.fn();

    await runMediaUpload(file, 'p1', { ...deps, onUploaded });

    expect(deps.putFile).not.toHaveBeenCalled();
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith('https://cdn/existing.png');
    expect(onUploaded).toHaveBeenCalledExactlyOnceWith({
      dedup: true,
      kind: 'image',
      fileUrl: 'https://cdn/existing.png',
      hash: HASH,
    });
  });

  it('hash degrade: hashing failed (null) → the upload still runs, hash omitted', async () => {
    const deps = makeUploadDeps({ hashFile: vi.fn().mockResolvedValue(null) });
    const onUploaded = vi.fn();

    await runMediaUpload(file, 'p1', { ...deps, onUploaded });

    expect(deps.presign).toHaveBeenCalledWith(
      expect.objectContaining({ hash: null }),
    );
    expect(deps.onSuccess).toHaveBeenCalledOnce();
    expect(onUploaded).toHaveBeenCalledExactlyOnceWith({
      key: 'k',
      kind: 'image',
      fileUrl: 'https://cdn/p.png',
      hash: null,
    });
  });

  it('retries a transient presign failure (5xx) before succeeding', async () => {
    const presign = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({
        uploadUrl: 'https://put',
        fileUrl: 'https://cdn/p.png',
        key: 'k',
        kind: 'image',
      });
    const deps = makeUploadDeps({ presign });

    await runMediaUpload(file, 'p1', deps);

    expect(presign).toHaveBeenCalledTimes(2);
    expect(deps.onSuccess).toHaveBeenCalledOnce();
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  it('reports failure when presign finally throws (PUT not attempted)', async () => {
    const deps = makeUploadDeps({
      presign: vi.fn().mockRejectedValue({ response: { status: 403 } }),
    });

    await runMediaUpload(file, 'p1', deps);

    expect(deps.putFile).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledOnce();
  });

  it('reports failure when the PUT throws', async () => {
    const deps = makeUploadDeps({
      putFile: vi.fn().mockRejectedValue(new Error('network')),
    });

    await runMediaUpload(file, 'p1', deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledOnce();
  });

  it('reports failure when the config fetch itself fails', async () => {
    const deps = makeUploadDeps({
      getUploadConfig: vi.fn().mockRejectedValue(new Error('down')),
    });

    await runMediaUpload(file, 'p1', deps);

    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledOnce();
  });
});

describe('fillNodeFromFile — fill an EXISTING node from a picked file (double-click / Upload menu)', () => {
  /** The owner triple the stubbed setHandling hands back (#1580 #7). */
  const LEASE = { gen: 1, clientId: 7, userId: 'u1' };

  /** Build the injected sinks + spies for a fill run. */
  function makeDeps(over: Partial<Parameters<typeof fillNodeFromFile>[4]> = {}) {
    return {
      getUploadConfig: vi.fn().mockResolvedValue(CFG),
      hashFile: vi.fn().mockResolvedValue(HASH),
      presign: vi.fn().mockResolvedValue({
        uploadUrl: 'https://put',
        fileUrl: 'https://cdn/p.png',
        key: 'k',
        kind: 'image',
      }),
      putFile: vi.fn().mockResolvedValue(undefined),
      extractText: vi.fn().mockResolvedValue('extracted body'),
      isHandling: vi.fn().mockReturnValue(false),
      onBusy: vi.fn(),
      onTypeMismatch: vi.fn(),
      setHandling: vi.fn().mockReturnValue(LEASE),
      setContent: vi.fn().mockReturnValue(true),
      setError: vi.fn().mockReturnValue(true),
      sleep: () => Promise.resolve(),
      ...over,
    };
  }

  it('media file: handling → upload → fill content with the public URL (no new node)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith('n1', 'https://cdn/p.png', LEASE);
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.extractText).not.toHaveBeenCalled();
  });

  it('media upload failure: writes a fixed-English error onto the node (not a toast)', async () => {
    const deps = makeDeps({ presign: vi.fn().mockRejectedValue(new Error('403')) });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'bad.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('n1', 'Upload failed: bad.png', LEASE);
  });

  it('non-media file: extract text locally → fill content (no upload)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'doc.txt', { type: 'text/plain' }),
      'text',
      'p1',
      deps,
    );
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith('n1', 'extracted body', LEASE);
  });

  it('extraction failure: writes a fixed-English error', async () => {
    const deps = makeDeps({
      extractText: vi.fn().mockRejectedValue(new Error('no parser')),
    });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'weird.bin', { type: 'application/octet-stream' }),
      'text',
      'p1',
      deps,
    );
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('n1', 'Extraction failed: weird.bin', LEASE);
  });

  it('busy gate (#1580 #7): a node already handling refuses the fill — onBusy fires, nothing else runs', async () => {
    const deps = makeDeps({ isHandling: vi.fn().mockReturnValue(true) });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.onBusy).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setHandling).not.toHaveBeenCalled();
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('missing node (#1580 #7): setHandling returns undefined — the fill aborts silently', async () => {
    const deps = makeDeps({ setHandling: vi.fn().mockReturnValue(undefined) });
    await fillNodeFromFile(
      'ghost',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('type gate: an mp4 VIDEO picked into an AUDIO node is refused - nothing runs (user bug 2026-07-03: macOS lets audio/* pickers select .mp4)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'clip.mp4', { type: 'video/mp4' }),
      'audio',
      'p1',
      deps,
    );
    expect(deps.onTypeMismatch).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setHandling).not.toHaveBeenCalled();
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('type gate: an audio-only mp4 container (audio/mp4, .m4a) into an AUDIO node is ACCEPTED', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'song.m4a', { type: 'audio/mp4' }),
      'audio',
      'p1',
      deps,
    );
    expect(deps.onTypeMismatch).not.toHaveBeenCalled();
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
  });

  it('type gate: an image into a TEXT node is refused (the gate is generic, not audio-specific)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'text',
      'p1',
      deps,
    );
    expect(deps.onTypeMismatch).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setHandling).not.toHaveBeenCalled();
  });
});

describe('computeDeletedAssetEntries — asset-delete report accounting', () => {
  const url = (n: string): string => `https://cdn/${n}.png`;

  it('reports a deleted media node\'s content + cover as separate entries', () => {
    const deleted = [
      { id: 'v1', type: 'video', data: { content: url('vid'), coverUrl: url('cover') } },
    ];
    const entries = computeDeletedAssetEntries(deleted, deleted, 'sp-1');
    expect(entries.map((e) => e.fileUrl).sort()).toEqual([url('cover'), url('vid')].sort());
    expect(entries.every((e) => e.nodeId === 'v1' && e.spaceId === 'sp-1')).toBe(true);
  });

  // ── Focus crops (#1782, adversarial R2): crops are uploaded assets too ──
  const crop = (id: string, u: string) => ({
    id,
    url: u,
    name: 'src',
    width: 10,
    height: 10,
  });

  it('reports a deleted node\'s focus crops (kind image) alongside its content', () => {
    const deleted = [
      {
        id: 'g1',
        type: 'image',
        data: { content: url('gen'), focusImages: [crop('f1', url('crop1'))] },
      },
    ];
    const entries = computeDeletedAssetEntries(deleted, deleted, 'sp-1');
    expect(entries.map((e) => e.fileUrl).sort()).toEqual(
      [url('crop1'), url('gen')].sort(),
    );
    expect(entries.every((e) => e.kind === 'image')).toBe(true);
  });

  it('a crop URL held by a SURVIVING node keeps the asset alive (both directions)', () => {
    const shared = url('shared-crop');
    // Deleted node's crop survives via another node's crop (dedup-shared URL).
    const deleted = [
      { id: 'a', type: 'image', data: { focusImages: [crop('f1', shared)] } },
    ];
    const all = [
      ...deleted,
      { id: 'b', type: 'image', data: { focusImages: [crop('f2', shared)] } },
    ];
    expect(computeDeletedAssetEntries(deleted, all, 'sp-1')).toEqual([]);
    // And a deleted CONTENT url survives via a survivor's crop.
    const deleted2 = [
      { id: 'c', type: 'image', data: { content: shared } },
    ];
    const all2 = [
      ...deleted2,
      { id: 'd', type: 'image', data: { focusImages: [crop('f3', shared)] } },
    ];
    expect(computeDeletedAssetEntries(deleted2, all2, 'sp-1')).toEqual([]);
  });

  it('a crop URL held by a SURVIVOR\'s style slot keeps the asset alive (round-12)', () => {
    // #333 style copies + dedup can make a node's styleImageUrl equal a
    // crop's asset URL — the survivor set must see the style slot, or the
    // ledger falsely reports the shared asset deleted.
    const shared = url('style-shared');
    const deleted = [
      { id: 'a', type: 'image', data: { focusImages: [crop('f1', shared)] } },
    ];
    const all = [
      ...deleted,
      { id: 'b', type: 'image', data: { styleImageUrl: shared } },
    ];
    expect(computeDeletedAssetEntries(deleted, all, 'sp-1')).toEqual([]);
  });

  it('isReportableAssetUrl mirrors the server parse contract (round-3)', () => {
    expect(isReportableAssetUrl('https://cdn/x.png')).toBe(true);
    expect(isReportableAssetUrl('http://cdn/x.png')).toBe(true);
    // Prefix-passing but unparseable / wrong scheme: rejected — one such
    // URL used to 400 the WHOLE multi-entry delete report batch.
    expect(isReportableAssetUrl('https://a b/x.png')).toBe(false);
    expect(isReportableAssetUrl('data:image/png;base64,xx')).toBe(false);
    expect(isReportableAssetUrl('blob:https://a/b')).toBe(false);
    // Parseable but overlong (server .max(2048)) — round-4.
    expect(isReportableAssetUrl('https://x/' + 'a'.repeat(2048))).toBe(false);
  });

  it('assetUrlSurvives sees content, cover, focus crops, and the style slot (round-12)', () => {
    const nodes = [
      { id: 'a', data: { content: url('c') } },
      { id: 'b', data: { focusImages: [crop('f1', url('f'))] } },
      { id: 'c', data: { styleImageUrl: url('s') } },
    ];
    expect(assetUrlSurvives(url('c'), nodes)).toBe(true);
    expect(assetUrlSurvives(url('f'), nodes)).toBe(true);
    expect(assetUrlSurvives(url('s'), nodes)).toBe(true);
    expect(assetUrlSurvives(url('ghost'), nodes)).toBe(false);
  });

  it('does NOT report a URL still referenced by a surviving node (pasted duplicate)', () => {
    const shared = url('shared');
    const deleted = [{ id: 'a', type: 'image', data: { content: shared } }];
    const all = [
      { id: 'a', type: 'image', data: { content: shared } },
      { id: 'b', type: 'image', data: { content: shared } }, // survivor holds the same URL
    ];
    expect(computeDeletedAssetEntries(deleted, all, 'sp-1')).toEqual([]);
  });

  it('reports the URL once the LAST referencing node is deleted', () => {
    const shared = url('shared');
    const deleted = [
      { id: 'a', type: 'image', data: { content: shared } },
      { id: 'b', type: 'image', data: { content: shared } },
    ];
    const entries = computeDeletedAssetEntries(deleted, deleted, 'sp-1');
    expect(entries.map((e) => e.fileUrl)).toContain(shared);
  });

  it('skips non-media nodes and non-http content (data:/blob: placeholders, errors)', () => {
    const deleted = [
      { id: 't', type: 'text', data: { content: url('ignored') } },
      { id: 'i', type: 'image', data: { content: 'data:image/png;base64,AAAA' } },
      { id: 'e', type: 'image', data: { content: 'Upload failed: x.png' } },
    ];
    expect(computeDeletedAssetEntries(deleted, deleted, 'sp-1')).toEqual([]);
  });
});
