// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import { isUploadableMediaType } from '@breatic/shared';

import {
  isReportableAssetUrl,
  fileToNodeSpec,
  checkFileAdmission,
  uploadAcceptFor,
  refusedFormatParams,
  fillNodeFromFile,
  computeDeletedAssetEntries,
  assetUrlSurvives,
} from '@web/spaces/canvas/canvas-upload';
import type { SlotSpec } from '@web/spaces/canvas/generate/slots';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlot } from '@web/spaces/canvas/generate/video-slots';

describe('uploadAcceptFor — what the picker offers', () => {
  // The picker and the admission gate answer the same question, so a type the
  // picker shows and the gate refuses is an offer we withdraw the moment it is
  // taken. Derived from the one list rather than typed out beside it.
  it.each(['image', 'video', 'audio'] as const)(
    'offers only formats %s uploads actually take',
    (modality) => {
      const offered = uploadAcceptFor(modality).split(',');

      expect(offered.length).toBeGreaterThan(0);
      for (const type of offered) {
        expect(isUploadableMediaType(type)).toBe(true);
        expect(type.startsWith(`${modality}/`)).toBe(true);
      }
    },
  );

  it('offers nothing a wildcard would have swept in', () => {
    expect(uploadAcceptFor('image')).not.toContain('*');
    expect(uploadAcceptFor('image')).not.toContain('image/gif');
    expect(uploadAcceptFor('video')).not.toContain('video/ogg');
  });

  // A picker filters by the name the operating system gives a file, and that
  // is not always the name the format is listed under. Offering only the
  // listed one greys out a file the gate would have taken — and one the same
  // change taught the gate to take.
  it('offers the other names a listed format goes by', () => {
    expect(uploadAcceptFor('video').split(',')).toContain('video/x-m4v');
    expect(uploadAcceptFor('audio').split(',')).toContain('audio/x-m4a');
    expect(uploadAcceptFor('image').split(',')).toContain('image/apng');
  });
});

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

  // The ticket endpoint refuses these too, so without this the user picks a
  // file, watches a node appear, and gets a permanent failure with an offer to
  // retry that cannot succeed. Refused on selection instead, before a node is
  // created and before a byte is sent (#240).
  it.each(['image/svg+xml', 'image/gif', 'video/ogg', 'audio/aiff'])(
    'refuses %s, which is the right family and a format we do not take',
    (type) => {
      expect(checkFileAdmission({ type, size: 500 }, CAP)).toBe(
        'unsupportedType',
      );
    },
  );

  it('takes a format on the list under any name it goes by', () => {
    // An .m4a is `audio/mp4` in the registry and `audio/x-m4a` to a browser.
    expect(checkFileAdmission({ type: 'audio/x-m4a', size: 500 }, CAP)).toBeNull();
  });

  // The list answers what may be uploaded. A file that is read locally never
  // reaches storage, so it is none of the list's business — a PDF becomes a
  // text node today and has to keep doing so.
  it.each(['text/plain', 'application/pdf', 'application/octet-stream'])(
    'leaves %s alone, which is read locally rather than uploaded',
    (type) => {
      expect(checkFileAdmission({ type, size: 500 }, CAP)).toBeNull();
    },
  );

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

/** A ticket for a one-part upload. */
const TICKET = {
  ticket: 'signed',
  storageKey: 'image/2026-08-31/p.png',
  uploadUrl: 'https://ingest.example.com',
  kind: 'image',
  partSize: 5 * 1024 * 1024,
  totalParts: 1,
  taskId: 'task-row-1',
};

describe('fillNodeFromFile — fill an EXISTING node from a picked file (double-click / Upload menu)', () => {
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
      onTypeMismatch: vi.fn(),
      setContent: vi.fn(),
      onExtractionFailure: vi.fn(),
      // The only exit for a failed upload. It is required: this module keeps
      // no copy of the sentences a user reads, so every failure hands its
      // reason out and CanvasSpace decides how to present it.
      onUploadFailure: vi.fn(),
      sleep: () => Promise.resolve(),
      ...over,
    };
  }

  it('media file: hands a failure to the one exit and writes nothing itself', async () => {
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

    expect(deps.onUploadFailure).toHaveBeenCalledOnce();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.onExtractionFailure).not.toHaveBeenCalled();
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
    expect(deps.sendToIngest).toHaveBeenCalledOnce();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.onExtractionFailure).not.toHaveBeenCalled();
    expect(deps.extractText).not.toHaveBeenCalled();
  });

  // inner#888 §7.5: a browser tool's export names the tool on its ticket, so
  // its task row reads as that tool.
  it('media file: puts the mini-tool tag on the ticket', async () => {
    const deps = makeDeps({ tag: { source: 'mini_tool', toolName: 'image-rotate' } });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.requestTicket).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'mini_tool', toolName: 'image-rotate', nodeId: 'n1' }),
    );
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
      { reason: 'upload' },
      file,
    );
    expect(deps.onExtractionFailure).not.toHaveBeenCalled();
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
    expect(deps.requestTicket).not.toHaveBeenCalled();
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith('n1', 'extracted body');
  });

  // inner#888 §7.8: a failure that never reached the server has no task row,
  // so it is told to the person who caused it and the node is left as it was
  // (decisions 2026-09-19: nodes are never deleted, row-less failures toast).
  it('extraction failure: hands the file to the toast and leaves the node untouched', async () => {
    const deps = makeDeps({
      extractText: vi.fn().mockRejectedValue(new Error('no parser')),
    });
    const file = new File(['x'], 'weird.bin', { type: 'application/octet-stream' });
    await fillNodeFromFile('n1', file, 'text', 'p1', deps);
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.onExtractionFailure).toHaveBeenCalledExactlyOnceWith(file);
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
    expect(deps.requestTicket).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.onExtractionFailure).not.toHaveBeenCalled();
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

  it('assetUrlSurvives sees content and focus crops (round-12)', () => {
    const nodes = [
      { id: 'a', data: { content: url('c') } },
      { id: 'b', data: { focusImages: [crop('f1', url('f'))] } },
    ];
    expect(assetUrlSurvives(url('c'), nodes)).toBe(true);
    expect(assetUrlSurvives(url('f'), nodes)).toBe(true);
    expect(assetUrlSurvives(url('ghost'), nodes)).toBe(false);
  });

  it('assetUrlSurvives sees the first-frame slot too (#1896 slice 2)', () => {
    // The video panel's first frame is a pick-time COPY held on the node —
    // and the survival set is a hand-kept list,
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

  it('assetUrlSurvives sees every image in the style slot (inner#826)', () => {
    // Style images are copies held in one list; any of them still in use
    // keeps its asset alive when the node it was picked from is deleted.
    const nodes = [{ id: 'g', data: { styleImageUrls: [url('s1'), url('s2')] } }];
    expect(assetUrlSurvives(url('s1'), nodes)).toBe(true);
    expect(assetUrlSurvives(url('s2'), nodes)).toBe(true);
    expect(assetUrlSurvives(url('s3'), nodes)).toBe(false);
  });

  it('sees every slot the video registry declares, not a list kept by hand (#1918)', () => {
    // Driven off the registry so a slot added there is covered the day it is
    // written. The two entries this replaces were added one PR at a time,
    // each with a comment saying the next one would need its own line — which
    // is the shape of an omission waiting to happen: leaving a slot out
    // reports an asset the video node is still generating from, and nothing
    // fails until a user deletes the node they picked it from.
    for (const slot of Object.keys(VIDEO_SLOTS) as VideoSlot[]) {
      const spec: SlotSpec = VIDEO_SLOTS[slot];
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

describe('refusedFormatParams', () => {
  // The refusal names what we would have taken, and the medium it names is
  // the one the person was offering — read off the file they picked, which is
  // the only thing either refusal gate has in common.
  it('names the image formats for a picture nothing takes', () => {
    expect(
      refusedFormatParams({ type: 'image/svg+xml' }),
    ).toEqual({ kind: 'image', formats: 'PNG / JPG / WebP' });
  });

  it('names the video formats for a film nothing takes', () => {
    expect(refusedFormatParams({ type: 'video/x-ms-wmv' })).toEqual({
      kind: 'video',
      formats: 'MP4 / WebM / MOV',
    });
  });

  it('names the audio formats for a sound nothing takes', () => {
    expect(refusedFormatParams({ type: 'audio/flac' })).toEqual({
      kind: 'audio',
      formats: 'MP3 / WAV / M4A / WebM',
    });
  });

  // A medium with no list of its own leaves the sentence its short form: the
  // select falls to `other`, which names nothing and needs nothing.
  it('leaves the sentence unqualified for anything else', () => {
    expect(refusedFormatParams({ type: 'model/gltf-binary' })).toEqual(
      { kind: 'other', formats: '' },
    );
  });
});
