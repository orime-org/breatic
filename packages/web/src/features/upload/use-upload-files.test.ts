// @vitest-environment jsdom

/**
 * F5 — `useUploadFiles` + `uploadOne` tests.
 *
 * Mocks `presign` + `uploadToPresignedUrl` (the only IO touchpoints)
 * and asserts the contract callers depend on:
 *
 *   - presign params include filename / content_type / project_id
 *   - PUT runs in parallel with media meta extraction
 *   - return shape carries fileUrl + kind + (where applicable) width
 *     / height / duration
 *   - the hook's `uploading` flag flips on entry and resets on
 *     completion (success or error)
 *   - errors bubble (caller wraps in try/catch)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { uploadOne, useUploadFiles, NODE_TYPE_BY_KIND } from './use-upload-files';

vi.mock('@/data/api/assets', () => ({
  presign: vi.fn(),
  uploadToPresignedUrl: vi.fn(),
}));

vi.mock('@/utils/mediaUtils', () => ({
  getImageMeta: vi.fn(),
  getVideoMeta: vi.fn(),
  getAudioMeta: vi.fn(),
}));

import { presign, uploadToPresignedUrl } from '@/data/api/assets';
import { getImageMeta, getVideoMeta, getAudioMeta } from '@/utils/mediaUtils';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('NODE_TYPE_BY_KIND', () => {
  it('maps image/video/audio to ReactFlow node types', () => {
    expect(NODE_TYPE_BY_KIND.image).toBe('1002');
    expect(NODE_TYPE_BY_KIND.video).toBe('1003');
    expect(NODE_TYPE_BY_KIND.audio).toBe('1004');
  });

  it('returns null for kinds without a node type yet', () => {
    expect(NODE_TYPE_BY_KIND.document).toBeNull();
    expect(NODE_TYPE_BY_KIND.file).toBeNull();
  });
});

describe('uploadOne — image', () => {
  it('passes filename + content_type + project_id to presign', async () => {
    vi.mocked(presign).mockResolvedValue({
      data: { uploadUrl: 'https://put/foo', fileUrl: 'https://cdn/foo', key: 'foo', kind: 'image' },
    } as never);
    vi.mocked(uploadToPresignedUrl).mockResolvedValue();
    vi.mocked(getImageMeta).mockResolvedValue({ width: 800, height: 600 });

    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    await uploadOne(file, { projectId: 'p1' });

    expect(presign).toHaveBeenCalledWith({
      filename: 'photo.png',
      content_type: 'image/png',
      project_id: 'p1',
    });
  });

  it('returns fileUrl + kind + width/height for image', async () => {
    vi.mocked(presign).mockResolvedValue({
      data: { uploadUrl: 'https://put/foo', fileUrl: 'https://cdn/foo', key: 'foo', kind: 'image' },
    } as never);
    vi.mocked(uploadToPresignedUrl).mockResolvedValue();
    vi.mocked(getImageMeta).mockResolvedValue({ width: 1920, height: 1080 });

    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    const result = await uploadOne(file, { projectId: 'p1' });

    expect(result).toEqual({
      file,
      fileUrl: 'https://cdn/foo',
      kind: 'image',
      width: 1920,
      height: 1080,
    });
  });

  it('falls back to application/octet-stream when File.type is empty', async () => {
    vi.mocked(presign).mockResolvedValue({
      data: { uploadUrl: 'u', fileUrl: 'f', key: 'k', kind: 'file' },
    } as never);
    vi.mocked(uploadToPresignedUrl).mockResolvedValue();

    const file = new File(['x'], 'mystery.bin', { type: '' });
    await uploadOne(file, { projectId: 'p1' });

    expect(presign).toHaveBeenCalledWith({
      filename: 'mystery.bin',
      content_type: 'application/octet-stream',
      project_id: 'p1',
    });
  });

  it('throws when presign returns no payload', async () => {
    vi.mocked(presign).mockResolvedValue({ data: undefined } as never);

    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    await expect(uploadOne(file, { projectId: 'p1' })).rejects.toThrow(/empty payload/i);
    expect(uploadToPresignedUrl).not.toHaveBeenCalled();
  });

  it('bubbles upload errors so the caller can surface them', async () => {
    vi.mocked(presign).mockResolvedValue({
      data: { uploadUrl: 'u', fileUrl: 'f', key: 'k', kind: 'image' },
    } as never);
    vi.mocked(uploadToPresignedUrl).mockRejectedValue(new Error('upload 500'));
    vi.mocked(getImageMeta).mockResolvedValue({});

    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    await expect(uploadOne(file, { projectId: 'p1' })).rejects.toThrow('upload 500');
  });
});

describe('uploadOne — modality-specific meta', () => {
  beforeEach(() => {
    vi.mocked(presign).mockResolvedValue({
      data: { uploadUrl: 'u', fileUrl: 'f', key: 'k', kind: 'image' },
    } as never);
    vi.mocked(uploadToPresignedUrl).mockResolvedValue();
  });

  it('extracts duration + dimensions for video', async () => {
    vi.mocked(getVideoMeta).mockResolvedValue({ width: 640, height: 360, duration: 12 });
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });

    const result = await uploadOne(file, { projectId: 'p1' });

    expect(getVideoMeta).toHaveBeenCalledWith(file);
    expect(getImageMeta).not.toHaveBeenCalled();
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
    expect(result.duration).toBe(12);
  });

  it('extracts duration for audio', async () => {
    vi.mocked(getAudioMeta).mockResolvedValue({ duration: 4.2 });
    const file = new File(['x'], 'note.webm', { type: 'audio/webm' });

    const result = await uploadOne(file, { projectId: 'p1' });

    expect(getAudioMeta).toHaveBeenCalledWith(file);
    expect(result.duration).toBe(4.2);
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
  });

  it('returns no meta for unsupported file kinds', async () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });

    const result = await uploadOne(file, { projectId: 'p1' });

    expect(getImageMeta).not.toHaveBeenCalled();
    expect(getVideoMeta).not.toHaveBeenCalled();
    expect(getAudioMeta).not.toHaveBeenCalled();
    expect(result.width).toBeUndefined();
  });
});

describe('useUploadFiles', () => {
  beforeEach(() => {
    vi.mocked(presign).mockResolvedValue({
      data: { uploadUrl: 'u', fileUrl: 'f', key: 'k', kind: 'image' },
    } as never);
    vi.mocked(uploadToPresignedUrl).mockResolvedValue();
    vi.mocked(getImageMeta).mockResolvedValue({});
  });

  it('returns an empty array without flipping uploading when files is empty', async () => {
    const { result } = renderHook(() => useUploadFiles());
    let returned: unknown;
    await act(async () => {
      returned = await result.current.upload([], { projectId: 'p1' });
    });
    expect(returned).toEqual([]);
    expect(presign).not.toHaveBeenCalled();
    expect(result.current.uploading).toBe(false);
  });

  it('uploads every file in parallel and resets uploading on success', async () => {
    const { result } = renderHook(() => useUploadFiles());
    const f1 = new File(['a'], 'a.png', { type: 'image/png' });
    const f2 = new File(['b'], 'b.png', { type: 'image/png' });
    await act(async () => {
      const out = await result.current.upload([f1, f2], { projectId: 'p1' });
      expect(out).toHaveLength(2);
      expect(out[0].file).toBe(f1);
      expect(out[1].file).toBe(f2);
    });
    expect(result.current.uploading).toBe(false);
    expect(presign).toHaveBeenCalledTimes(2);
  });

  it('resets uploading even when an upload throws', async () => {
    vi.mocked(uploadToPresignedUrl).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useUploadFiles());
    const f = new File(['a'], 'a.png', { type: 'image/png' });

    await act(async () => {
      await expect(
        result.current.upload([f], { projectId: 'p1' }),
      ).rejects.toThrow('boom');
    });
    expect(result.current.uploading).toBe(false);
  });
});
