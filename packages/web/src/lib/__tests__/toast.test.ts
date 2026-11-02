// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above the file, so the mock functions must be created via
// vi.hoisted to exist when the factory runs. Typed params keep `.mock.calls`
// tuple-indexable (the id assertions read call[1].id).
const sonnerMock = vi.hoisted(() => {
  const typed = (): ReturnType<typeof vi.fn> =>
    vi.fn((_message?: unknown, _options?: { id?: string; onAutoClose?: (t: { id: string }) => void; onDismiss?: (t: { id: string }) => void }) => 'id');
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

import { _unmuteToastsForTests, muteToasts, toast } from '@web/lib/toast';

describe('toast wrapper — the app\'s single, typed, content-deduped entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives a stable id from type + message so identical repeats refresh one toast', () => {
    toast.error('boom');
    expect(sonnerMock.error).toHaveBeenCalledWith('boom', expect.objectContaining({ id: 'error:boom' }));
  });

  it('keys the id by TYPE too — the same text at different severities are distinct toasts', () => {
    toast.error('x');
    toast.warning('x');
    expect(sonnerMock.error).toHaveBeenCalledWith('x', expect.objectContaining({ id: 'error:x' }));
    expect(sonnerMock.warning).toHaveBeenCalledWith('x', expect.objectContaining({ id: 'warning:x' }));
  });

  it('merges caller options under the derived id', () => {
    toast.info('hi', { duration: 5000 });
    expect(sonnerMock.info).toHaveBeenCalledWith('hi', expect.objectContaining({
      duration: 5000,
      id: 'info:hi',
    }));
  });

  it('a caller-provided id WINS (e.g. warnNodeGate\'s fixed id)', () => {
    toast.warning('locked', { id: 'canvas-node-gate' });
    expect(sonnerMock.warning).toHaveBeenCalledWith('locked', expect.objectContaining({
      id: 'canvas-node-gate',
    }));
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

describe('muteToasts — nothing else is worth reading once the page must reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _unmuteToastsForTests();
  });

  it('clears what is on screen and shows nothing typed afterwards', () => {
    muteToasts();
    expect(sonnerMock.dismiss).toHaveBeenCalledTimes(1);
    toast.error('a');
    toast.warning('b');
    toast.success('c');
    toast.info('d');
    expect(sonnerMock.error).not.toHaveBeenCalled();
    expect(sonnerMock.warning).not.toHaveBeenCalled();
    expect(sonnerMock.success).not.toHaveBeenCalled();
    expect(sonnerMock.info).not.toHaveBeenCalled();
  });

  describe('a repeat that lands while the previous toast is closing', () => {
    /** The options sonner received on the latest success call. */
    const lastOptions = (): { id?: string; onAutoClose?: (t: { id: string }) => void; onDismiss?: (t: { id: string }) => void } =>
      sonnerMock.success.mock.calls.at(-1)?.[1] ?? {};

    it('shows as a new toast after the previous one closed on its own', () => {
      toast.success('closing auto');
      const first = lastOptions();
      first.onAutoClose?.({ id: first.id ?? '' });
      toast.success('closing auto');
      expect(lastOptions().id).not.toBe(first.id);
    });

    it('shows as a new toast after the previous one was dismissed', () => {
      toast.success('closing dismissed');
      const first = lastOptions();
      first.onDismiss?.({ id: first.id ?? '' });
      toast.success('closing dismissed');
      expect(lastOptions().id).not.toBe(first.id);
    });

    it('keeps refreshing the new toast when the repeat after a close repeats again', () => {
      toast.success('closed then twice');
      const first = lastOptions();
      first.onAutoClose?.({ id: first.id ?? '' });
      toast.success('closed then twice');
      const second = lastOptions().id;
      toast.success('closed then twice');
      expect(second).not.toBe(first.id);
      expect(lastOptions().id).toBe(second);
    });

    it('shows a caller-keyed toast again after the previous one closed', () => {
      const warned = (): { id?: string; onAutoClose?: (t: { id: string }) => void } => sonnerMock.warning.mock.calls.at(-1)?.[1] ?? {};
      toast.warning('locked', { id: 'probe-gate' });
      const first = warned();
      expect(first.id).toBe('probe-gate');
      first.onAutoClose?.({ id: first.id ?? '' });
      toast.warning('locked', { id: 'probe-gate' });
      expect(warned().id).not.toBe('probe-gate');
    });

    it('keeps refreshing the same toast while it is still showing', () => {
      toast.success('still showing');
      const first = lastOptions().id;
      toast.success('still showing');
      expect(lastOptions().id).toBe(first);
    });

    it('still calls the caller\'s own close callbacks', () => {
      const onAutoClose = vi.fn(); const onDismiss = vi.fn();
      toast.success('caller callbacks', { onAutoClose, onDismiss });
      const options = lastOptions();
      options.onAutoClose?.({ id: options.id ?? '' });
      options.onDismiss?.({ id: options.id ?? '' });
      expect(onAutoClose).toHaveBeenCalledOnce();
      expect(onDismiss).toHaveBeenCalledOnce();
    });
  });
});
