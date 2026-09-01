// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import {
  isReportableAssetUrl,
  fileToNodeSpec,
  checkFileAdmission,
  fillNodeFromFile,
  runMediaUpload,
  computeDeletedAssetEntries,
  assetUrlSurvives,
} from '@web/spaces/canvas/canvas-upload';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type {
  VideoSlot,
  VideoSlotSpec,
} from '@web/spaces/canvas/generate/video-slots';

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

/**
 * An error the API layer would have thrown for `status`.
 * @param status - The status the server answered with.
 * @returns The exception the caller sees.
 */
function apiError(status: number): ApiException {
  return new ApiException({ status, message: `HTTP ${status}` });
}

/** A ticket for a one-part upload. */
const TICKET = {
  ticket: 'signed',
  storageKey: 'image/2026-08-31/p.png',
  uploadUrl: 'https://ingest.example.com',
  kind: 'image',
  partSize: 5 * 1024 * 1024,
  totalParts: 1,
};

/** Shared orchestration deps (config + hash + network spies). */
function makeUploadDeps(
  over: Partial<Parameters<typeof runMediaUpload>[2]> = {},
): Parameters<typeof runMediaUpload>[2] {
  return {
    getUploadConfig: vi.fn().mockResolvedValue(CFG),
    hashFile: vi.fn().mockResolvedValue(HASH),
    requestTicket: vi.fn().mockResolvedValue(TICKET),
    sendToIngest: vi.fn().mockResolvedValue({
      fileUrl: 'https://cdn/p.png',
      kind: 'image',
    }),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

describe('runMediaUpload — ask for a ticket, send the bytes, hand back the outcome', () => {
  const file = new File(['x'], 'photo.png', { type: 'image/png' });
  const context = { projectId: 'p1', leaseGen: 6, nodeId: 'n1', spaceId: 's1' };

  it('asks with what the server signs a ticket from, then sends the file', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(file, context, deps);

    expect(deps.requestTicket).toHaveBeenCalledWith({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: file.size,
      hash: HASH,
      leaseGen: 6,
      nodeId: 'n1',
      spaceId: 's1',
    });
    expect(deps.sendToIngest).toHaveBeenCalledWith(file, TICKET, CFG);
    expect(deps.onFailure).not.toHaveBeenCalled();
  });

  // The node reads its result from Yjs and ignores this; an upload with no
  // node behind it has no other channel and reads it here (design §9).
  it('hands back what completing the upload said it became', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(file, context, deps);

    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith('https://cdn/p.png');
  });

  it('sends nothing when the studio already holds the content', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockResolvedValue({
        alreadyExists: true,
        fileUrl: 'https://cdn/existing.png',
        kind: 'image',
      }),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onSuccess).toHaveBeenCalledExactlyOnceWith(
      'https://cdn/existing.png',
    );
  });

  // No hash, no upload (user decision 2026-07-26): the ledger keys on content,
  // and a file we cannot fingerprint has nothing to key on.
  it('refuses before any network call when the file cannot be hashed', async () => {
    const deps = makeUploadDeps({ hashFile: vi.fn().mockResolvedValue(null) });

    await runMediaUpload(file, context, deps);

    expect(deps.requestTicket).not.toHaveBeenCalled();
    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('hash');
  });

  it('retries a transient ticket failure before succeeding', async () => {
    const requestTicket = vi
      .fn()
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValue(TICKET);
    const deps = makeUploadDeps({ requestTicket });

    await runMediaUpload(file, context, deps);

    expect(requestTicket).toHaveBeenCalledTimes(2);
    expect(deps.onSuccess).toHaveBeenCalledOnce();
  });

  // No ticket means no grant, so nothing on the server knows this upload was
  // ever attempted and nobody will announce how it ended.
  it('sends nothing when the ticket request finally fails', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockRejectedValue(apiError(503)),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.sendToIngest).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('upload');
  });

  // Named apart from a ticket failure so the node's message and its Retry
  // stash can differ, even though both are the browser's to write.
  it('names a failure sending the bytes apart from one asking for a ticket', async () => {
    const deps = makeUploadDeps({
      sendToIngest: vi.fn().mockRejectedValue(new Error('part refused')),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('upload');
  });

  // A full account is not something a retry fixes, and the message the user
  // needs is a different one.
  it('names a full account apart from an ordinary failure', async () => {
    const deps = makeUploadDeps({
      requestTicket: vi.fn().mockRejectedValue(apiError(507)),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('storage');
  });

  it('reports a failure when the knobs cannot be fetched', async () => {
    const deps = makeUploadDeps({
      getUploadConfig: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await runMediaUpload(file, context, deps);

    expect(deps.requestTicket).not.toHaveBeenCalled();
    expect(deps.onFailure).toHaveBeenCalledExactlyOnceWith('upload');
  });

  // A crop is a byproduct with no node: registered for dedup, and told apart
  // from a real upload in the feed.
  it('carries the byproduct flag and leaves out the node context', async () => {
    const deps = makeUploadDeps();

    await runMediaUpload(
      file,
      { projectId: 'p1', leaseGen: 0, derived: true },
      deps,
    );

    expect(deps.requestTicket).toHaveBeenCalledWith({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: file.size,
      hash: HASH,
      leaseGen: 0,
      derived: true,
    });
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
      requestTicket: vi.fn().mockResolvedValue(TICKET),
      sendToIngest: vi.fn().mockResolvedValue({
        fileUrl: 'https://cdn/p.png',
        kind: 'image',
      }),
      extractText: vi.fn().mockResolvedValue('extracted body'),
      isHandling: vi.fn().mockReturnValue(false),
      onBusy: vi.fn(),
      onTypeMismatch: vi.fn(),
      setHandling: vi.fn().mockReturnValue(LEASE),
      setContent: vi.fn().mockReturnValue(true),
      setError: vi.fn().mockReturnValue(true),
      // The only exit for a failed upload. It is required: this module keeps
      // no copy of the sentences a user reads, so every failure hands its
      // reason out and CanvasSpace decides how to present it.
      onUploadFailure: vi.fn(),
      onUploadSettled: vi.fn(),
      sleep: () => Promise.resolve(),
      ...over,
    };
  }

  // Delivered bytes mean the file is no longer worth holding for a Retry this
  // node is not offered any more. The drop path says the same thing, and a
  // stash only one of them clears is a stash that outlives its node.
  it('media file: says so once the bytes are delivered', async () => {
    const deps = makeDeps();

    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );

    expect(deps.onUploadSettled).toHaveBeenCalledExactlyOnceWith('n1');
  });

  it('media file: says nothing of the sort when the upload failed', async () => {
    const deps = makeDeps({
      sendToIngest: vi.fn().mockRejectedValue(new Error('network')),
    });

    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );

    expect(deps.onUploadSettled).not.toHaveBeenCalled();
    expect(deps.onUploadFailure).toHaveBeenCalledOnce();
  });

  // The node opens handling and stays there. What it ends up holding comes
  // from the server through Yjs, so this path writes nothing on the way out
  // (design §6.6).
  it('media file: opens handling, sends the bytes, writes nothing itself', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.sendToIngest).toHaveBeenCalledOnce();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.extractText).not.toHaveBeenCalled();
  });

  it('media upload failure: reports the reason, and does not write the node itself', async () => {
    const deps = makeDeps({
      requestTicket: vi.fn().mockRejectedValue(new Error('403')),
    });
    const file = new File(['x'], 'bad.png', { type: 'image/png' });
    await fillNodeFromFile('n1', file, 'image', 'p1', deps);
    expect(deps.setContent).not.toHaveBeenCalled();
    // The fixed English sentence on the node is written by the one exit that
    // owns it; this pins only that the reason was handed over.
    expect(deps.onUploadFailure).toHaveBeenCalledExactlyOnceWith(
      'upload',
      'n1',
      file,
      LEASE,
    );
    expect(deps.setError).not.toHaveBeenCalled();
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
    expect(deps.requestTicket).not.toHaveBeenCalled();
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
    expect(deps.requestTicket).not.toHaveBeenCalled();
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
    expect(deps.requestTicket).not.toHaveBeenCalled();
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
    expect(deps.requestTicket).not.toHaveBeenCalled();
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

  it('sees every slot the video registry declares, not a list kept by hand (#1918)', () => {
    // Driven off the registry so a slot added there is covered the day it is
    // written. The two entries this replaces were added one PR at a time,
    // each with a comment saying the next one would need its own line — which
    // is the shape of an omission waiting to happen: leaving a slot out
    // reports an asset the video node is still generating from, and nothing
    // fails until a user deletes the node they picked it from.
    for (const slot of Object.keys(VIDEO_SLOTS) as VideoSlot[]) {
      const spec: VideoSlotSpec = VIDEO_SLOTS[slot];
      const held = url(`held-by-${slot}`);
      const stored = spec.storesCover ? { url: held } : held;
      const nodes = [{ data: { [spec.field]: stored } }];
      expect(
        assetUrlSurvives(held, nodes),
        `${slot} does not keep its asset alive`,
      ).toBe(true);
      if (spec.storesCover) {
        // The poster is a second uploaded asset held by the same pick.
        const poster = url(`poster-of-${slot}`);
        expect(
          assetUrlSurvives(poster, [
            { data: { [spec.field]: { url: held, cover: poster } } },
          ]),
          `${slot} does not keep its poster alive`,
        ).toBe(true);
      }
    }
  });

  it('does not report a driving video still held by a surviving node (#1918)', () => {
    // The poster counts too: it is a second uploaded asset, copied into the
    // slot at pick time on the same terms as the video itself.
    const video = url('driving');
    const cover = url('driving-cover');
    const deleted = [
      { id: 'src', type: 'video', data: { content: video, coverUrl: cover } },
    ];
    const all = [
      { id: 'src', type: 'video', data: { content: video, coverUrl: cover } },
      {
        id: 'gen',
        type: 'video',
        data: { drivingVideo: { url: video, cover } },
      },
    ];
    expect(computeDeletedAssetEntries(deleted, all, 'sp-1')).toEqual([]);
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
