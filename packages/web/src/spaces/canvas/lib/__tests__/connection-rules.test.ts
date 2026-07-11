// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { canConnect } from '@web/spaces/canvas/lib/connection-rules';

// Node-type connection rules (user 2026-07-10, spec §9.1 + same-day
// extension): what may wire into a node's input is a product rule —
//   image input ← { image, text }
//   video input ← { text, video, audio, image }
//   text  input ← { text, video, audio, image }
//   audio input ← { text }
// Anything not on a target's whitelist is rejected at the wire level, not
// silently dropped later at execute time.
describe('canConnect', () => {
  describe('image input — { image, text }', () => {
    it('allows image → image (i2i source reference)', () => {
      expect(canConnect('image', 'image')).toBe(true);
    });

    it('allows text → image (prompt-content reference)', () => {
      expect(canConnect('text', 'image')).toBe(true);
    });

    it('rejects audio / video → image (user-named rejection)', () => {
      expect(canConnect('audio', 'image')).toBe(false);
      expect(canConnect('video', 'image')).toBe(false);
    });

    it('rejects every non-whitelisted source (whitelist, not blacklist)', () => {
      expect(canConnect('3d', 'image')).toBe(false);
      expect(canConnect('web', 'image')).toBe(false);
      expect(canConnect('annotation', 'image')).toBe(false);
      expect(canConnect('group', 'image')).toBe(false);
    });
  });

  describe('video input — { text, video, audio, image }', () => {
    it('allows all four content modalities', () => {
      expect(canConnect('text', 'video')).toBe(true);
      expect(canConnect('video', 'video')).toBe(true);
      expect(canConnect('audio', 'video')).toBe(true);
      expect(canConnect('image', 'video')).toBe(true);
    });

    it('rejects non-content sources', () => {
      expect(canConnect('3d', 'video')).toBe(false);
      expect(canConnect('web', 'video')).toBe(false);
      expect(canConnect('group', 'video')).toBe(false);
    });
  });

  describe('text input — { text, video, audio, image }', () => {
    it('allows all four content modalities', () => {
      expect(canConnect('text', 'text')).toBe(true);
      expect(canConnect('video', 'text')).toBe(true);
      expect(canConnect('audio', 'text')).toBe(true);
      expect(canConnect('image', 'text')).toBe(true);
    });

    it('rejects non-content sources', () => {
      expect(canConnect('web', 'text')).toBe(false);
      expect(canConnect('annotation', 'text')).toBe(false);
    });
  });

  describe('audio input — { text } only', () => {
    it('allows text → audio', () => {
      expect(canConnect('text', 'audio')).toBe(true);
    });

    it('rejects everything else, including audio → audio', () => {
      expect(canConnect('image', 'audio')).toBe(false);
      expect(canConnect('video', 'audio')).toBe(false);
      expect(canConnect('audio', 'audio')).toBe(false);
      expect(canConnect('3d', 'audio')).toBe(false);
    });
  });

  it('leaves undeclared targets unrestricted (3d / web have no ratified input rule yet)', () => {
    expect(canConnect('audio', '3d')).toBe(true);
    expect(canConnect('video', 'web')).toBe(true);
  });

  it('is safe on unknown / corrupt kinds (fail closed on whitelisted targets, open on undeclared)', () => {
    // Yjs-synced kinds are untrusted; an out-of-range value must never crash
    // and must not slip past a ratified whitelist.
    expect(canConnect('sticker' as never, 'image')).toBe(false);
    expect(canConnect('sticker' as never, 'audio')).toBe(false);
    expect(canConnect('sticker' as never, '3d')).toBe(true);
  });
});
