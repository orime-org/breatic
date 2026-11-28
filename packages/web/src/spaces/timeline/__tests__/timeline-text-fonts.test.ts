// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Choosing the font slices one text clip needs (inner#1709 design §5.3 "选分片"): each character takes the first family
 * in `TIMELINE_TEXT_FONT_FAMILIES` order whose `glyphRange` covers it, and within that family the one slice covering it
 * (a family's slices are disjoint); the slice covering U+0020 is always added, being the first available font that sets
 * the line height; a character no family covers is left to the system font and selects nothing.
 *
 * The slices below are a small stand-in for one font set version, with the disjoint glyph ranges `glyphs.json`
 * carries; the families are the real ones.
 */

import { describe, expect, it } from 'vitest';
import { TIMELINE_TEXT_FONT_FAMILIES } from '@breatic/shared';

import { timelineTextFontSlices } from '@web/spaces/timeline/timeline-text-fonts';

const SLICES = [
  { family: 'Inter', file: 'inter-latin', glyphRange: 'U+0000-00FF,U+0131,U+0152-0153' },
  { family: 'Inter', file: 'inter-latin-ext', glyphRange: 'U+0100-0130,U+0132-0151,U+0154-024F' },
  { family: 'Inter', file: 'inter-vietnamese', glyphRange: 'U+0300-0301,U+1EA0-1EF9' },
  { family: 'Noto Sans SC', file: 'noto-sans-sc-han', glyphRange: 'U+4E00-9FFF' },
  { family: 'Noto Sans TC', file: 'noto-sans-tc-han', glyphRange: 'U+3100-312F,U+4E00-9FFF' },
  { family: 'Noto Sans JP', file: 'noto-sans-jp-kana', glyphRange: 'U+3040-30FF' },
  { family: 'Noto Sans JP', file: 'noto-sans-jp-han', glyphRange: 'U+4E00-9FFF' },
  { family: 'Noto Sans KR', file: 'noto-sans-kr-hangul', glyphRange: 'U+AC00-D7AF' },
  { family: 'Noto Sans KR', file: 'noto-sans-kr-han', glyphRange: 'U+4E00-9FFF' },
] as const;

/**
 * The chosen slice files, sorted.
 * @param body - The text body.
 * @returns The files.
 * @throws {never} Never.
 */
function chosen(body: string): string[] {
  return [...timelineTextFontSlices(body, SLICES)].sort();
}

describe('timelineTextFontSlices (design §5.3, §10 web unit tests)', () => {
  it('keeps the family order of the web interface: Inter, then SC before TC, JP and KR', () => {
    expect([...TIMELINE_TEXT_FONT_FAMILIES]).toEqual(['Inter', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans JP', 'Noto Sans KR']);
  });

  it('chooses one CJK family slice for a Chinese body, plus the Inter Latin slice that covers the space', () => {
    expect(chosen('你好')).toEqual(['inter-latin', 'noto-sans-sc-han']);
  });

  it('chooses the KR slice for Hangul, not the SC or TC slices', () => {
    expect(chosen('한국')).toEqual(['inter-latin', 'noto-sans-kr-hangul']);
  });

  it('chooses SC for kanji and JP for kana in a Japanese body', () => {
    expect(chosen('ひらがな漢字')).toEqual(['inter-latin', 'noto-sans-jp-kana', 'noto-sans-sc-han']);
  });

  it('chooses exactly one slice for the Vietnamese ă (U+0103) and for the combining acute U+0301', () => {
    expect(chosen('ă')).toEqual(['inter-latin', 'inter-latin-ext']);
    expect(chosen('á')).toEqual(['inter-latin', 'inter-vietnamese']);
  });

  it('chooses nothing for a character no family covers, reading the body by code point', () => {
    expect(chosen('\u{1F600}')).toEqual(['inter-latin']);
  });

  it('chooses the space slice once for a Latin body', () => {
    expect(chosen('Hello world')).toEqual(['inter-latin']);
  });
});
