// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above the file, so the mock functions must be created via
// vi.hoisted to exist when the factory runs. Typed params keep `.mock.calls`
// tuple-indexable (the id assertions read call[1].id).
const sonnerMock = vi.hoisted(() => {
  const typed = (): ReturnType<typeof vi.fn> =>
    vi.fn((_message?: unknown, _options?: { id?: string }) => 'id');
  return {
    error: typed(),
    warning: typed(),
    success: typed(),
    info: typed(),
    loading: vi.fn(() => 'id'),
    promise: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  };
});
vi.mock('sonner', () => ({ toast: sonnerMock }));

import { toast } from '@web/lib/toast';

describe('toast wrapper — the app\'s single, typed, content-deduped entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives a stable id from type + message so identical repeats refresh one toast', () => {
    toast.error('boom');
    expect(sonnerMock.error).toHaveBeenCalledWith('boom', { id: 'error:boom' });
  });

  it('keys the id by TYPE too — the same text at different severities are distinct toasts', () => {
    toast.error('x');
    toast.warning('x');
    expect(sonnerMock.error).toHaveBeenCalledWith('x', { id: 'error:x' });
    expect(sonnerMock.warning).toHaveBeenCalledWith('x', { id: 'warning:x' });
  });

  it('merges caller options under the derived id', () => {
    toast.info('hi', { duration: 5000 });
    expect(sonnerMock.info).toHaveBeenCalledWith('hi', {
      duration: 5000,
      id: 'info:hi',
    });
  });

  it('a caller-provided id WINS (e.g. warnNodeGate\'s fixed id)', () => {
    toast.warning('locked', { id: 'canvas-node-gate' });
    expect(sonnerMock.warning).toHaveBeenCalledWith('locked', {
      id: 'canvas-node-gate',
    });
  });

  it('a non-string message gets no auto id (content cannot be content-keyed)', () => {
    // A number is a valid ReactNode but not a string, so there is no stable
    // content key — pass the caller options (here none) straight through.
    toast.error(42);
    expect(sonnerMock.error).toHaveBeenCalledWith(42, undefined);
  });

  it('two identical calls produce the SAME id (dedup — new refreshes old)', () => {
    toast.warning('again');
    toast.warning('again');
    const ids = sonnerMock.warning.mock.calls.map((c) => c[1]?.id);
    expect(ids).toEqual(['warning:again', 'warning:again']);
  });

  it('passes loading / promise / dismiss / custom straight through to sonner', () => {
    expect(toast.loading).toBe(sonnerMock.loading);
    expect(toast.promise).toBe(sonnerMock.promise);
    expect(toast.dismiss).toBe(sonnerMock.dismiss);
    expect(toast.custom).toBe(sonnerMock.custom);
  });
});
