// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import {
  isReportableAssetUrl,
  fileToNodeSpec,
  checkFileAdmission,
  fillNodeFromFile,
  runMediaUpload,
  runVideoUploadWithCover,
  computeDeletedAssetEntries,
  assetUrlSurvives,
} from '@web/spaces/canvas/canvas-upload';

describe('checkFileAdmission — which files the canvas refuses on selection', () => {
  const CAP = 1024;

  it('admits an ordinary file', () => {
    expect(checkFileAdmission({ type: 'image/png', size: 500 }, CAP)).toBeNull();
  });

  it('refuses a 0-byte file, whatever its type (user decision 2026-07-26)', () => {
    // An empty file makes an empty node — there is nothing to show, nothing to
    // dedup against, and nothing worth a storage row. Refused on SELECTION so
    // no node is created and no byte is sent.
    expect(checkFileAdmission({ type: 'image/png', size: 0 }, CAP)).toBe('empty');
    expect(checkFileAdmission({ type: 'video/mp4', size: 0 }, CAP)).toBe('empty');
    // Text files never upload, but an empty one is just as pointless.
    expect(checkFileAdmission({ type: 'text/plain', size: 0 }, CAP)).toBe('empty');
  });

  it('refuses an over-cap file that would be uploaded', () => {
    expect(checkFileAdmission({ type: 'image/png', size: CAP + 1 }, CAP)).toBe(
      'tooLarge',
    );
  });

  it('admits a file exactly at the cap (boundary)', () => {
    expect(checkFileAdmission({ type: 'image/png', size: CAP }, CAP)).toBeNull();
  });

  it('does NOT apply the cap to a file that is never uploaded (text is read locally)', () => {
    expect(
      checkFileAdmission({ type: 'text/plain', size: CAP + 1 }, CAP),
    ).toBeNull();
  });

  it('admits any size when the cap is unknown (config fetch failed → server 413 stays authoritative)', () => {
    expect(
      checkFileAdmission({ type: 'image/png', size: 9e9 }, Infinity),
    ).toBeNull();
    // …but an empty file is still refused: that check needs no config at all.
    expect(checkFileAdmission({ type: 'image/png', size: 0 }, Infinity)).toBe(
      'empty',
    );
  });
});

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

  it('hashing failed (null) → the upload is REFUSED before any network call (user decision 2026-07-26)', async () => {
    // The content hash is the whole storage design's ticket: instant-dedup,
    // within-studio dedup and the ledger row all key on it. An upload without
    // one can never be registered (`studio_assets.content_hash` is NOT NULL),
    // so it would pin the node to an object with no live row — an offline-GC
    // orphan → 404. Refusing UP FRONT also wastes no bandwidth: nothing is
    // presigned and nothing is PUT. (This replaces the old availability-first
    // rule that let a hashless upload through as "stored but untracked".)
    const deps = makeUploadDeps({ hashFile: vi.fn().mockResolvedValue(null) });
    const onUploaded = vi.fn();

    await runMediaUpload(file, 'p1', { ...deps, onUploaded });

    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.putFile).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    // The caller needs to tell "we could not fingerprint the file" apart from a
    // network failure — the remedy differs (reload the page vs retry).
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('hash');
  });

  it('retries a transient presign failure (5xx) before succeeding', async () => {
    const presign = vi
      .fn()
      // Flat `.status`, the shape apiGet's interceptor normalises every
      // presign failure into. The raw axios `{response:{status}}` shape this
      // used to seed cannot leave the axios instance.
      .mockRejectedValueOnce({ status: 503 })
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
    // The real thing apiGet rejects with, rather than a hand-written shape.
    // It used to be seeded as `{ response: { status: 403 } }` — the raw axios
    // shape, which the interceptor no longer lets out and which `errorStatus`
    // no longer reads. That fixture still went green, but for a changed
    // reason: not "403 is final, so no retry", but "no status could be read
    // at all". The 403 in it had stopped reaching any code.
    const deps = makeUploadDeps({
      presign: vi.fn().mockRejectedValue(
        new ApiException({ status: 403, message: 'forbidden' }),
      ),
    });

    await runMediaUpload(file, 'p1', deps);

    // Called ONCE, which is what makes the 403 in the fixture load-bearing.
    // Without this the same test passes with a 503 in there, and then it is
    // only checking that an exhausted presign reports failure — which the
    // status could not affect either way.
    expect(deps.presign).toHaveBeenCalledTimes(1);
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

  it('pins the REPORT canonical, never the presign temp key (§0 rule 2 / §4.1 step 7)', async () => {
    // The presign URL is a temp minted key; onSuccess must fire with the
    // registered CANONICAL the report returns, not that temp key.
    const deps = makeUploadDeps({
      presign: vi.fn().mockResolvedValue({
        uploadUrl: 'https://put',
        fileUrl: 'https://cdn/TEMP.png',
        key: 'k',
        kind: 'image',
      }),
    });
    const onUploaded = vi.fn().mockResolvedValue({ fileUrl: 'https://cdn/CANON.png' });

    await runMediaUpload(file, 'p1', { ...deps, onUploaded });

    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith('https://cdn/CANON.png');
    expect(deps.onSuccess).not.toHaveBeenCalledWith('https://cdn/TEMP.png');
  });

  it('keeps the node handling until the report returns: report resolves BEFORE onSuccess pins', async () => {
    const order: string[] = [];
    let resolveReport: (v: { fileUrl: string }) => void = () => {};
    const onUploaded = vi.fn(() => {
      order.push('report');
      return new Promise<{ fileUrl: string }>((r) => {
        resolveReport = r;
      });
    });
    const deps = makeUploadDeps({ onSuccess: vi.fn(() => order.push('pin')) });

    const done = runMediaUpload(file, 'p1', { ...deps, onUploaded });
    await new Promise((r) => setTimeout(r, 0));
    // Report fired; the node is NOT pinned yet (still handling).
    expect(order).toEqual(['report']);
    expect(deps.onSuccess).not.toHaveBeenCalled();

    resolveReport({ fileUrl: 'https://cdn/c.png' });
    await done;
    // Pinned only AFTER the report resolved with the canonical.
    expect(order).toEqual(['report', 'pin']);
  });

  it('a report failure (node-bound register 422) → onFailure, node NOT pinned (Retry)', async () => {
    const onUploaded = vi.fn().mockRejectedValue(new Error('422'));
    const deps = makeUploadDeps();

    await runMediaUpload(file, 'p1', { ...deps, onUploaded });

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledOnce();
  });
});

const VIDEO_FILE = new File(['v'], 'clip.mp4', { type: 'video/mp4' });
const COVER_FILE = new File(['c'], 'clip-cover.png', { type: 'image/png' });

/**
 * Deps for {@link runVideoUploadWithCover}: config + hash shared, presign +
 * PUT keyed on the file so the video and cover get distinct URLs / can fail
 * independently.
 * @param over - Per-test overrides.
 * @returns The atomic video-with-cover orchestration deps.
 */
function makeVideoCoverDeps(
  over: Partial<Parameters<typeof runVideoUploadWithCover>[3]> = {},
): Parameters<typeof runVideoUploadWithCover>[3] {
  return {
    getUploadConfig: vi.fn().mockResolvedValue(CFG),
    hashFile: vi.fn().mockResolvedValue(HASH),
    presign: vi.fn().mockImplementation((params: { contentType: string }) =>
      Promise.resolve(
        params.contentType.startsWith('video/')
          ? {
            uploadUrl: 'https://put/v',
            fileUrl: 'https://cdn/clip.mp4',
            key: 'kv',
            kind: 'video',
          }
          : {
            uploadUrl: 'https://put/c',
            fileUrl: 'https://cdn/clip-cover.png',
            key: 'kc',
            kind: 'image',
          },
      ),
    ),
    putFile: vi.fn().mockResolvedValue(undefined),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    // The video report returns the REGISTERED canonical(s) the node pins; the
    // default matches the presign URLs so the happy-path assertions hold.
    onVideoUploaded: vi.fn().mockResolvedValue({
      fileUrl: 'https://cdn/clip.mp4',
      coverUrl: 'https://cdn/clip-cover.png',
    }),
    onCoverUploaded: vi.fn(),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

describe('runVideoUploadWithCover — atomic video + cover (#1816)', () => {
  it('writes content + cover ONCE when both uploads succeed, and reports both assets', async () => {
    const deps = makeVideoCoverDeps();

    await runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);

    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith(
      'https://cdn/clip.mp4',
      'https://cdn/clip-cover.png',
    );
    expect(deps.onFailure).not.toHaveBeenCalled();
    // Both ledger reports fire (video WITH nodeId at the caller; cover WITHOUT).
    // The video report carries BOTH infos (#1824): the caller rides the cover's
    // verifiable ref on the VIDEO report so the server can re-derive the cover
    // URL for the node-history row (①) + activity row (②).
    expect(deps.onVideoUploaded).toHaveBeenCalledExactlyOnceWith(
      { key: 'kv', kind: 'video', fileUrl: 'https://cdn/clip.mp4', hash: HASH },
      { key: 'kc', kind: 'image', fileUrl: 'https://cdn/clip-cover.png', hash: HASH },
    );
    expect(deps.onCoverUploaded).toHaveBeenCalledOnce();
  });

  it('awaits the cover report BEFORE firing the video report (read-after-write, #1826 §4.5)', async () => {
    // The video report rides only the cover's HASH; the server reads the cover's
    // studio_assets row by that hash. So the cover MUST register first — else the
    // node-history + activity thumbnails race to a null row → Film.
    const order: string[] = [];
    let resolveCover: () => void = () => {};
    const deps = makeVideoCoverDeps({
      onCoverUploaded: vi.fn(() => {
        order.push('cover');
        return new Promise<void>((r) => {
          resolveCover = r;
        });
      }),
      onVideoUploaded: vi.fn(() => {
        order.push('video');
        return Promise.resolve({ fileUrl: 'https://cdn/clip.mp4' });
      }),
    });

    const done = runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);
    // Flush the uploads + reach the `await onCoverUploaded` suspend point.
    await new Promise((r) => setTimeout(r, 0));
    // The cover report fired; the video report MUST wait for it to resolve.
    expect(order).toEqual(['cover']);
    expect(deps.onVideoUploaded).not.toHaveBeenCalled();

    resolveCover();
    await done;
    // Video report fires only AFTER the cover row is committed.
    expect(order).toEqual(['cover', 'video']);
  });

  it('fails atomically when the VIDEO PUT fails — no write, no reports', async () => {
    const deps = makeVideoCoverDeps({
      putFile: vi
        .fn()
        .mockImplementation((url: string) =>
          url === 'https://put/v'
            ? Promise.reject(new Error('net'))
            : Promise.resolve(),
        ),
    });

    await runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledOnce();
    // No phantom node-history row / attribution for an aborted atomic upload.
    expect(deps.onVideoUploaded).not.toHaveBeenCalled();
    expect(deps.onCoverUploaded).not.toHaveBeenCalled();
  });

  it('fails atomically when the COVER PUT fails — never writes video-only', async () => {
    const deps = makeVideoCoverDeps({
      putFile: vi
        .fn()
        .mockImplementation((url: string) =>
          url === 'https://put/c'
            ? Promise.reject(new Error('net'))
            : Promise.resolve(),
        ),
    });

    await runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledOnce();
    expect(deps.onVideoUploaded).not.toHaveBeenCalled();
    expect(deps.onCoverUploaded).not.toHaveBeenCalled();
  });

  it('pins the VIDEO REPORT canonical (content + coverUrl), not the presign temp keys (§0 rule 2)', async () => {
    const deps = makeVideoCoverDeps({
      onVideoUploaded: vi.fn().mockResolvedValue({
        fileUrl: 'https://cdn/CANON.mp4',
        coverUrl: 'https://cdn/CANON-cover.png',
      }),
    });

    await runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);

    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith(
      'https://cdn/CANON.mp4',
      'https://cdn/CANON-cover.png',
    );
    expect(deps.onSuccess).not.toHaveBeenCalledWith(
      'https://cdn/clip.mp4',
      'https://cdn/clip-cover.png',
    );
  });

  it('cover degrade: report.coverUrl undefined → pins undefined (Film), NEVER the presign temp cover key (§0 rule 2 / §4.5 / #1824)', async () => {
    // The server degrades the cover to `undefined` when it cannot resolve a live
    // studio_assets row (the cover register failed, or its hash degraded so no
    // row was written). The node MUST then show Film — never the cover's presign
    // TEMP key, which has no live row and becomes an offline-GC orphan → 404. The
    // `?? cover.url` fallback that re-pinned that temp key was the G8 regression on
    // the cover half (Gate-2 R3). `completeNodeHandling` skips `coverUrl` when it
    // is undefined, so passing undefined through is exactly "degrade to Film".
    const deps = makeVideoCoverDeps({
      onVideoUploaded: vi.fn().mockResolvedValue({
        fileUrl: 'https://cdn/CANON.mp4',
        // coverUrl omitted → the server degraded the cover to Film.
      }),
    });

    await runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);

    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith(
      'https://cdn/CANON.mp4',
      undefined,
    );
    // The cover's presign temp key (from the sub-upload) must NEVER be pinned.
    expect(deps.onSuccess).not.toHaveBeenCalledWith(
      'https://cdn/CANON.mp4',
      'https://cdn/clip-cover.png',
    );
  });

  it('a COVER report failure fails the whole upload — the two halves are atomic (#1816, user 2026-07-26)', async () => {
    // #1816's contract is "a video never lands without its cover and a cover
    // never lands without its video". That has always held for a failed PUT;
    // it must hold for a failed REGISTER too, otherwise the video lands while
    // its cover silently isn't in the ledger. So onCoverUploaded rejecting
    // aborts the whole thing: no node write, no video report, Retry offered.
    const deps = makeVideoCoverDeps({
      onCoverUploaded: vi.fn().mockRejectedValue(new Error('cover register 422')),
    });

    await runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('upload');
    // The video report never fires — no half-written ledger state.
    expect(deps.onVideoUploaded).not.toHaveBeenCalled();
  });

  it('a video report failure (e.g. register 422) → onFailure, node NOT written (retry both)', async () => {
    const deps = makeVideoCoverDeps({
      onVideoUploaded: vi.fn().mockRejectedValue(new Error('422')),
    });

    await runVideoUploadWithCover(VIDEO_FILE, COVER_FILE, 'p1', deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
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

  /**
   * A presign keyed on content type so the video and cover get distinct URLs
   * (the atomic video-with-cover fill path uploads both).
   * @param params - The presign params (only `contentType` is read).
   * @returns The presign response for a video or a cover.
   */
  const videoCoverPresign = (params: {
    contentType: string;
  }): Promise<unknown> =>
    Promise.resolve(
      params.contentType.startsWith('video/')
        ? {
          uploadUrl: 'https://put/v',
          fileUrl: 'https://cdn/clip.mp4',
          key: 'kv',
          kind: 'video',
        }
        : {
          uploadUrl: 'https://put/c',
          fileUrl: 'https://cdn/clip-cover.png',
          key: 'kc',
          kind: 'image',
        },
    );

  it('video pre-flight reject (#1816): extraction null → NO setHandling, empty node untouched, onExtractRejected fires', async () => {
    const deps = makeDeps({
      extractVideoCover: vi.fn().mockResolvedValue(null),
      onExtractRejected: vi.fn(),
    });
    await fillNodeFromFile('n1', VIDEO_FILE, 'video', 'p1', deps);
    expect(deps.extractVideoCover).toHaveBeenCalledOnce();
    expect(deps.onExtractRejected).toHaveBeenCalledExactlyOnceWith('n1');
    // The empty node is never touched: no lease, no upload, no write.
    expect(deps.setHandling).not.toHaveBeenCalled();
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('video with cover (#1816): extraction ok → atomic upload → setContent gets content + coverUrl; both assets reported', async () => {
    const deps = makeDeps({
      presign: vi.fn().mockImplementation(videoCoverPresign),
      extractVideoCover: vi
        .fn()
        .mockResolvedValue(new Blob(['c'], { type: 'image/png' })),
      // The reporter returns the REGISTERED canonical(s) — the node pins those,
      // never the presign temp keys (report-then-pin, §0 rule 2). Canonical URLs
      // are deliberately DISTINCT from the presign temp keys so the assertion
      // actually guards the pin source.
      onUploaded: vi.fn().mockResolvedValue({
        fileUrl: 'https://cdn/CANON.mp4',
        coverUrl: 'https://cdn/CANON-cover.png',
      }),
      onCoverUploaded: vi.fn(),
    });
    await fillNodeFromFile('n1', VIDEO_FILE, 'video', 'p1', deps);
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    // The cover File is declared PNG (§8) by `videoCoverFile`, not by the blob
    // it wraps. Asserting the presign contract is what pins that declaration
    // from this side: on S3 / OSS the declared type is signed into the upload
    // URL and becomes the stored object's Content-Type, so a regression here
    // mislabels the asset itself, not just the request.
    expect(deps.presign).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'clip-cover.png',
        contentType: 'image/png',
      }),
    );
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith(
      'n1',
      'https://cdn/CANON.mp4',
      LEASE,
      'https://cdn/CANON-cover.png',
    );
    // NEVER the presign temp keys.
    expect(deps.setContent).not.toHaveBeenCalledWith(
      'n1',
      'https://cdn/clip.mp4',
      LEASE,
      'https://cdn/clip-cover.png',
    );
    // Video ledger report carries the nodeId AND the cover info (#1824) so the
    // caller can ride the cover ref on the video report; cover report has no
    // nodeId (F3).
    expect(deps.onUploaded).toHaveBeenCalledExactlyOnceWith(
      'n1',
      expect.objectContaining({ key: 'kv', kind: 'video' }),
      expect.objectContaining({ key: 'kc', kind: 'image' }),
    );
    expect(deps.onCoverUploaded).toHaveBeenCalledOnce();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('video atomic failure (#1816): cover PUT fails → setError, never writes video-only', async () => {
    const deps = makeDeps({
      presign: vi.fn().mockImplementation(videoCoverPresign),
      putFile: vi
        .fn()
        .mockImplementation((url: string) =>
          url === 'https://put/c'
            ? Promise.reject(new Error('net'))
            : Promise.resolve(),
        ),
      extractVideoCover: vi
        .fn()
        .mockResolvedValue(new Blob(['c'], { type: 'image/png' })),
    });
    await fillNodeFromFile('n1', VIDEO_FILE, 'video', 'p1', deps);
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith(
      'n1',
      'Upload failed: clip.mp4',
      LEASE,
    );
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

  it('assetUrlSurvives sees the first-frame slot too (#1896 slice 2)', () => {
    // The video panel's first frame is a pick-time COPY held on the node, the
    // same shape as the style slot — and the survival set is a hand-kept list,
    // so a new slot does NOT get counted just by looking like an existing one.
    // Missing here, deleting the node the frame was picked FROM reports an
    // asset that is still in use.
    const nodes = [{ id: 'v', data: { firstFrameUrl: url('ff') } }];
    expect(assetUrlSurvives(url('ff'), nodes)).toBe(true);
  });

  it('assetUrlSurvives sees the end-frame slot too (#1904)', () => {
    // Second slot, same hand-kept list: resembling the first frame counts for
    // nothing here, so the end frame needs its own line or deleting the image
    // it was picked from reports an asset that is still in use.
    const nodes = [{ id: 'v', data: { endFrameUrl: url('ef') } }];
    expect(assetUrlSurvives(url('ef'), nodes)).toBe(true);
  });

  it('does not report an end frame still held by a surviving video node', () => {
    // The other half of the same list: the deletion report is computed from
    // the surviving set, which is a second hand-kept copy of it.
    const shared = url('picked-last');
    const deleted = [{ id: 'img', type: 'image', data: { content: shared } }];
    const all = [
      { id: 'img', type: 'image', data: { content: shared } },
      { id: 'vid', type: 'video', data: { endFrameUrl: shared } },
    ];
    expect(computeDeletedAssetEntries(deleted, all, 'sp-1')).toEqual([]);
  });

  it('does not report a first frame still held by a surviving video node', () => {
    // Delete the image the frame was picked from: the copy on the video node
    // keeps that asset alive, so nothing may be reported.
    const shared = url('picked');
    const deleted = [{ id: 'img', type: 'image', data: { content: shared } }];
    const all = [
      { id: 'img', type: 'image', data: { content: shared } },
      { id: 'vid', type: 'video', data: { firstFrameUrl: shared } },
    ];
    expect(computeDeletedAssetEntries(deleted, all, 'sp-1')).toEqual([]);
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
