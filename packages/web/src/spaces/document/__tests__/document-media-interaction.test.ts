// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { documentBarsOf, mediaBarShown, mediaEvent } from '@web/spaces/document/document-bars';

describe('document media interaction ownership', () => {
  it('pins an inline seek host until release, then takes the queued explicit request', () => {
    const editor = {};
    const first = document.createElement('div');
    const next = document.createElement('div');
    const release = vi.fn();
    mediaEvent(editor, { type: 'seek-start', host: first, release });
    mediaEvent(editor, { type: 'open', host: next, origin: 'keyboard' });
    expect(mediaBarShown(documentBarsOf(editor), first, false)).toBe(true);
    expect(mediaBarShown(documentBarsOf(editor), next, false)).toBe(false);
    mediaEvent(editor, { type: 'seek-end', host: first, focused: false });
    expect(documentBarsOf(editor).media.request).toEqual({ host: next, origin: 'keyboard' });
    expect(mediaBarShown(documentBarsOf(editor), next, false)).toBe(true);
  });

  it('hands caption focus over by host and epoch, clearing focused and seeking activity', () => {
    const editor = {};
    const host = document.createElement('div');
    const release = vi.fn();
    mediaEvent(editor, { type: 'open', host, origin: 'keyboard' });
    mediaEvent(editor, { type: 'seek-start', host, release });
    mediaEvent(editor, { type: 'caption', host });
    const intent = documentBarsOf(editor).media.intent!;
    expect(release).toHaveBeenCalledOnce();
    expect(documentBarsOf(editor).media.request).toBeNull();
    expect(documentBarsOf(editor).media.activity).toBeNull();
    mediaEvent(editor, { type: 'focus', host, focused: true });
    expect(documentBarsOf(editor).media.activity).toBeNull();
    mediaEvent(editor, { type: 'complete-caption', host, epoch: intent.epoch - 1 });
    expect(documentBarsOf(editor).media.intent).toBe(intent);
    mediaEvent(editor, { type: 'complete-caption', host, epoch: intent.epoch });
    expect(documentBarsOf(editor).media.intent).toBeNull();
  });

  it('invalidates caption handoff on a new request and ignores the old host release', () => {
    const editor = {};
    const first = document.createElement('div');
    const next = document.createElement('div');
    mediaEvent(editor, { type: 'caption', host: first });
    const epoch = documentBarsOf(editor).media.intent!.epoch;
    mediaEvent(editor, { type: 'open', host: next, origin: 'keyboard' });
    mediaEvent(editor, { type: 'complete-caption', host: first, epoch });
    mediaEvent(editor, { type: 'release', host: first });
    expect(documentBarsOf(editor).media.intent).toBeNull();
    expect(documentBarsOf(editor).media.request).toEqual({ host: next, origin: 'keyboard' });
  });

  it('keeps keyboard ownership over incidental pointer hover and releases on outside focus', () => {
    const editor = {};
    const first = document.createElement('div');
    const next = document.createElement('div');
    mediaEvent(editor, { type: 'open', host: first, origin: 'keyboard' });
    mediaEvent(editor, { type: 'hover', host: next, on: true });
    expect(mediaBarShown(documentBarsOf(editor), first, false)).toBe(true);
    mediaEvent(editor, { type: 'outside', host: first });
    expect(documentBarsOf(editor).media.request).toBeNull();
    expect(documentBarsOf(editor).media.activity).toBeNull();
  });
  it('keeps a newly focused host when the previous host releases after closing', () => {
    const editor = {};
    const first = document.createElement('div');
    const next = document.createElement('div');
    mediaEvent(editor, { type: 'open', host: first, origin: 'keyboard' });
    mediaEvent(editor, { type: 'escape', host: first });
    mediaEvent(editor, { type: 'focus', host: next, focused: true });
    mediaEvent(editor, { type: 'release', host: first });
    expect(documentBarsOf(editor).media.activity).toEqual({ host: next, kind: 'focused' });
  });

  it('gives the bar to the hovered host over a host whose controls only keep focus after a seek', () => {
    const editor = {};
    const first = document.createElement('div');
    const next = document.createElement('div');
    mediaEvent(editor, { type: 'hover', host: first, on: true });
    mediaEvent(editor, { type: 'seek-start', host: first, release: vi.fn() });
    mediaEvent(editor, { type: 'seek-end', host: first, focused: true });
    mediaEvent(editor, { type: 'hover', host: first, on: false });
    mediaEvent(editor, { type: 'hover', host: next, on: true });
    expect(mediaBarShown(documentBarsOf(editor), next, false)).toBe(true);
    expect(mediaBarShown(documentBarsOf(editor), first, false)).toBe(false);
    mediaEvent(editor, { type: 'hover', host: next, on: false });
    expect(mediaBarShown(documentBarsOf(editor), first, false)).toBe(true);
  });

  it('shows the selected block only when no host is hovered, requested or active', () => {
    const editor = {};
    const host = document.createElement('div');
    expect(mediaBarShown(documentBarsOf(editor), host, true)).toBe(true);
    expect(mediaBarShown(documentBarsOf(editor), host, false)).toBe(false);
  });
});
