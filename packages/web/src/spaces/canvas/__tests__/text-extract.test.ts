// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  pickExtractor,
  extractText,
  type ExtractDeps,
} from '@web/spaces/canvas/text-extract';

describe('pickExtractor — MIME → which extractor (or null)', () => {
  it('maps text/* and text-like application types to the direct text reader', () => {
    expect(pickExtractor('text/plain')).toBe('text');
    expect(pickExtractor('text/markdown')).toBe('text');
    expect(pickExtractor('text/csv')).toBe('text');
    expect(pickExtractor('application/json')).toBe('text');
    expect(pickExtractor('application/xml')).toBe('text');
  });

  it('maps pdf / docx / xlsx (incl. legacy .xls) to their library extractors', () => {
    expect(pickExtractor('application/pdf')).toBe('pdf');
    expect(
      pickExtractor(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
    expect(
      pickExtractor(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('xlsx');
    expect(pickExtractor('application/vnd.ms-excel')).toBe('xlsx');
  });

  it('returns null for types with no extractor (binary / media / empty)', () => {
    expect(pickExtractor('application/zip')).toBeNull();
    expect(pickExtractor('application/octet-stream')).toBeNull();
    expect(pickExtractor('')).toBeNull();
    // media is classified by fileToNodeSpec, never reaches extraction
    expect(pickExtractor('image/png')).toBeNull();
  });
});

describe('extractText — dispatch + delegation (libs injected)', () => {
  let deps: ExtractDeps;

  beforeEach(() => {
    deps = {
      pdf: vi.fn().mockResolvedValue('pdf text'),
      docx: vi.fn().mockResolvedValue('docx text'),
      xlsx: vi.fn().mockResolvedValue('xlsx text'),
    };
  });

  it('reads text/* files directly without calling any library', async () => {
    const file = new File(['hello world'], 'a.txt', { type: 'text/plain' });
    await expect(extractText(file, deps)).resolves.toBe('hello world');
    expect(deps.pdf).not.toHaveBeenCalled();
    expect(deps.docx).not.toHaveBeenCalled();
    expect(deps.xlsx).not.toHaveBeenCalled();
  });

  it('delegates a pdf to deps.pdf and returns its text', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', {
      type: 'application/pdf',
    });
    await expect(extractText(file, deps)).resolves.toBe('pdf text');
    expect(deps.pdf).toHaveBeenCalledOnce();
  });

  it('delegates docx / xlsx to their deps', async () => {
    const docx = new File([new Uint8Array([1])], 'a.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const xlsx = new File([new Uint8Array([1])], 'a.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await expect(extractText(docx, deps)).resolves.toBe('docx text');
    await expect(extractText(xlsx, deps)).resolves.toBe('xlsx text');
  });

  it('throws for a file with no extractor (so the caller writes an error)', async () => {
    const file = new File([new Uint8Array([1])], 'a.zip', {
      type: 'application/zip',
    });
    await expect(extractText(file, deps)).rejects.toThrow();
  });
});
